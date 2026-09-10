//! Locked, append-only evidence for a paid request. A damaged log never permits a retry.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event<T> {
    pub schema_version: u32,
    pub at_unix: u64,
    pub previous_hash: String,
    pub event_hash: String,
    pub body: T,
}

pub struct Journal<T> {
    file: File,
    events: Vec<Event<T>>,
    bytes: usize,
    failed_write: bool,
}

impl<T: Clone + Serialize + DeserializeOwned> Journal<T> {
    pub fn create(path: &Path, body: T, now: u64) -> Result<Self, &'static str> {
        let mut options = OpenOptions::new();
        options.read(true).append(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|_| "Paid journal already exists or cannot be created.")?;
        file.try_lock()
            .map_err(|_| "Paid journal is locked by another operation.")?;
        let mut journal = Self {
            file,
            events: Vec::new(),
            bytes: 0,
            failed_write: false,
        };
        journal.append(body, now)?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "Unable to make the new journal directory entry durable.")?;
        Ok(journal)
    }

    pub fn open(path: &Path) -> Result<Self, &'static str> {
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .open(path)
            .map_err(|_| "An existing paid journal is required; no replacement is created.")?;
        file.try_lock()
            .map_err(|_| "Paid journal is locked by another operation.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Unable to inspect paid journal.")?;
        if !metadata.is_file() {
            return Err("Paid journal must be a regular file.");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("Paid journal permissions must exclude group and other access.");
            }
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Unable to read paid journal.")?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES || !bytes.ends_with(b"\n") {
            return Err("Paid journal is empty, oversized or has a torn append; never resubmit.");
        }
        let input = std::str::from_utf8(&bytes).map_err(|_| "Paid journal is not UTF-8.")?;
        let mut previous = "0".repeat(64);
        let mut last_time = 0;
        let mut events = Vec::new();
        for line in input.lines() {
            if events.len() >= MAX_EVENTS {
                return Err("Paid journal has too many events.");
            }
            let event: Event<T> =
                serde_json::from_str(line).map_err(|_| "Invalid paid journal event.")?;
            if event.schema_version != 1
                || event.previous_hash != previous
                || event.at_unix < last_time
                || event.event_hash != digest(&event)?
            {
                return Err("Paid journal integrity or event ordering failed.");
            }
            previous = event.event_hash.clone();
            last_time = event.at_unix;
            events.push(event);
        }
        Ok(Self {
            file,
            events,
            bytes: bytes.len(),
            failed_write: false,
        })
    }

    pub fn events(&self) -> &[Event<T>] {
        &self.events
    }

    pub fn append(&mut self, body: T, now: u64) -> Result<(), &'static str> {
        if self.failed_write {
            return Err(
                "A journal write already failed; close this handle without further actions.",
            );
        }
        if self.events.len() >= MAX_EVENTS
            || self.events.last().is_some_and(|last| last.at_unix > now)
        {
            return Err("Paid journal event limit or clock ordering failed.");
        }
        let mut event = Event {
            schema_version: 1,
            at_unix: now,
            previous_hash: self
                .events
                .last()
                .map_or_else(|| "0".repeat(64), |last| last.event_hash.clone()),
            event_hash: String::new(),
            body,
        };
        event.event_hash = digest(&event)?;
        let mut bytes = serde_json::to_vec(&event).map_err(|_| "Unable to encode paid event.")?;
        bytes.push(b'\n');
        if self.bytes.saturating_add(bytes.len()) > MAX_BYTES {
            return Err("Paid journal exceeds its byte limit.");
        }
        if self
            .file
            .write_all(&bytes)
            .and_then(|()| self.file.sync_all())
            .is_err()
        {
            self.failed_write = true;
            return Err("Paid journal write or sync failed; do not send or retry.");
        }
        self.bytes += bytes.len();
        self.events.push(event);
        Ok(())
    }
}

fn digest<T: Clone + Serialize>(event: &Event<T>) -> Result<String, &'static str> {
    let mut value = event.clone();
    value.event_hash.clear();
    serde_json::to_vec(&value)
        .map(|bytes| crate::sha256_hex(&bytes))
        .map_err(|_| "Unable to hash paid journal event.")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn a_competing_process_cannot_acquire_the_paid_journal_lock() {
        const CHILD_PATH: &str = "ULTRATOKENIZER_PAID_LOCK_TEST_PATH";
        if let Ok(path) = std::env::var(CHILD_PATH) {
            assert!(Journal::<String>::open(Path::new(&path)).is_err());
            return;
        }
        let path =
            std::env::temp_dir().join(format!("ut-paid-process-lock-{}.jsonl", std::process::id()));
        let journal = Journal::create(&path, "fixture".to_owned(), 1).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "paid_journal::tests::a_competing_process_cannot_acquire_the_paid_journal_lock",
            ])
            .env(CHILD_PATH, &path)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        drop(journal);
        let reopened = Journal::<String>::open(&path).unwrap();
        assert_eq!(reopened.events().len(), 1);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn locked_append_chain_survives_reopen_and_rejects_torn_or_changed_data() {
        let directory = std::env::temp_dir().join(format!(
            "ut-paid-journal-{}-{}",
            std::process::id(),
            crate::unix_time().unwrap()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.jsonl");
        let mut journal = Journal::create(&path, "first".to_owned(), 1).unwrap();
        assert!(Journal::<String>::open(&path).is_err());
        assert!(Journal::create(&path, "replacement".to_owned(), 2).is_err());
        journal.append("second".to_owned(), 2).unwrap();
        drop(journal);
        let journal = Journal::<String>::open(&path).unwrap();
        assert_eq!(journal.events().len(), 2);
        drop(journal);
        let good = std::fs::read(&path).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{")
            .unwrap();
        assert!(Journal::<String>::open(&path).is_err());
        std::fs::write(
            &path,
            String::from_utf8(good)
                .unwrap()
                .replace("second", "changed"),
        )
        .unwrap();
        assert!(Journal::<String>::open(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
