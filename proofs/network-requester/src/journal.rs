//! Append-only staging evidence for external artifact and program writes.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub const STAGING_SUFFIX: &str = ".sp1-network-staging.jsonl";
const MAX_STAGING_JOURNAL_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
// Serde cannot combine `deny_unknown_fields` on this flattened envelope with
// an internally tagged enum. The enum below owns strict field rejection.
#[serde(rename_all = "camelCase")]
pub struct StageEvent {
    pub schema_version: u32,
    pub at_unix: u64,
    pub operation_id: String,
    #[serde(flatten)]
    pub body: StageEventBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum StageEventBody {
    Intent {
        preparation_id: String,
        requester: String,
        elf_sha256: String,
        witness_sha256: String,
        proof_request_allowed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_disclosure: Option<crate::disclosure::PublicDisclosure>,
    },
    ProgramObserved {
        registered: bool,
        program_uri: Option<String>,
    },
    ArtifactAllocationAttempted {
        artifact_kind: String,
    },
    ArtifactAllocationAmbiguous {
        artifact_kind: String,
    },
    ArtifactAllocated {
        artifact_kind: String,
        artifact_uri: String,
    },
    ArtifactUploadAttempted {
        artifact_kind: String,
        artifact_uri: String,
        payload_sha256: String,
        payload_bytes: usize,
    },
    ArtifactUploadAmbiguous {
        artifact_kind: String,
        artifact_uri: String,
        payload_sha256: String,
        payload_bytes: usize,
    },
    ArtifactUploaded {
        artifact_kind: String,
        artifact_uri: String,
        payload_sha256: String,
        payload_bytes: usize,
    },
    ProgramRegistrationAttempted {
        nonce: u64,
        body_sha256: String,
    },
    ProgramRegistrationAmbiguous {
        nonce: u64,
        body_sha256: String,
    },
    ProgramRegistered {
        program_uri: String,
        transaction_hash: String,
    },
    Complete {
        preparation_id: String,
        requester: String,
        program_uri: String,
        stdin_uri: String,
        witness_sha256: String,
        proof_request_submitted: bool,
    },
}

pub fn create(path: &Path, event: &StageEvent) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Staging journal already exists or cannot be created.")?;
    write_event(&mut file, event)
}

pub fn append(path: &Path, event: &StageEvent) -> Result<(), &'static str> {
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|_| "Unable to reopen staging journal.")?;
    write_event(&mut file, event)
}

pub fn read(path: &Path) -> Result<Vec<StageEvent>, &'static str> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Unable to open staging journal.")?
        .take(MAX_STAGING_JOURNAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read staging journal.")?;
    if bytes.len() > MAX_STAGING_JOURNAL_BYTES {
        return Err("Staging journal exceeds its size limit.");
    }
    parse(&bytes)
}

pub fn parse(bytes: &[u8]) -> Result<Vec<StageEvent>, &'static str> {
    if bytes.len() > MAX_STAGING_JOURNAL_BYTES {
        return Err("Staging journal exceeds its size limit.");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Staging journal is not UTF-8.")?;
    let events: Result<Vec<_>, _> = text.lines().map(serde_json::from_str).collect();
    let events = events.map_err(|_| "Staging journal contains an invalid event.")?;
    if events.is_empty() {
        return Err("Staging journal is empty.");
    }
    validate(&events)?;
    Ok(events)
}

fn validate(events: &[StageEvent]) -> Result<(), &'static str> {
    let StageEventBody::Intent {
        preparation_id,
        requester,
        witness_sha256,
        proof_request_allowed,
        public_disclosure,
        ..
    } = &events[0].body
    else {
        return Err("Staging journal must begin with an intent.");
    };
    if *proof_request_allowed || preparation_id.is_empty() || requester.is_empty() {
        return Err("Staging intent is malformed or permits a proof request.");
    }
    if let Some(disclosure) = public_disclosure {
        disclosure.validate_shape()?;
        if &disclosure.preparation_id != preparation_id || &disclosure.requester != requester {
            return Err("Public staging intent differs from its disclosure authorization.");
        }
    }
    let stdin_kind = crate::disclosure::artifact_kind(public_disclosure.as_ref());
    let operation_id = &events[0].operation_id;
    if !is_prefixed_hash(operation_id) {
        return Err("Staging operation identity is malformed.");
    }

    let mut last_at = 0;
    let mut observed_program: Option<bool> = None;
    let mut allocations = BTreeMap::<String, String>::new();
    let mut uploaded = BTreeSet::<String>::new();
    let mut registration_attempt: Option<(u64, String)> = None;
    let mut registered_program: Option<String> = None;

    for (index, event) in events.iter().enumerate() {
        if event.schema_version != 1
            || event.operation_id != *operation_id
            || event.at_unix < last_at
        {
            return Err("Staging journal event envelope is inconsistent.");
        }
        last_at = event.at_unix;
        let previous = index.checked_sub(1).and_then(|value| events.get(value));
        match &event.body {
            StageEventBody::Intent { .. } if index == 0 => {}
            StageEventBody::Intent { .. } => {
                return Err("Staging journal contains more than one intent.");
            }
            StageEventBody::ProgramObserved {
                registered,
                program_uri,
            } => {
                if index != 1
                    || observed_program.is_some()
                    || (*registered != program_uri.is_some())
                    || program_uri.as_deref() == Some("")
                {
                    return Err("Staging program observation is inconsistent.");
                }
                observed_program = Some(*registered);
                if *registered {
                    registered_program.clone_from(program_uri);
                }
            }
            StageEventBody::ArtifactAllocationAttempted { artifact_kind } => {
                validate_artifact_kind(artifact_kind)?;
                if (artifact_kind != "synthetic_program" && artifact_kind != stdin_kind)
                    || observed_program.is_none()
                    || allocations.contains_key(artifact_kind)
                    || uploaded.contains(artifact_kind)
                {
                    return Err("Staging artifact allocation attempt is out of order.");
                }
            }
            StageEventBody::ArtifactAllocationAmbiguous { artifact_kind } => {
                if !matches!(
                    previous.map(|event| &event.body),
                    Some(StageEventBody::ArtifactAllocationAttempted { artifact_kind: prior }) if prior == artifact_kind
                ) || index + 1 != events.len()
                {
                    return Err("Ambiguous artifact allocation is not terminal or matched.");
                }
            }
            StageEventBody::ArtifactAllocated {
                artifact_kind,
                artifact_uri,
            } => {
                if artifact_uri.is_empty()
                    || !matches!(
                        previous.map(|event| &event.body),
                        Some(StageEventBody::ArtifactAllocationAttempted { artifact_kind: prior }) if prior == artifact_kind
                    )
                    || allocations
                        .insert(artifact_kind.clone(), artifact_uri.clone())
                        .is_some()
                {
                    return Err("Staging artifact allocation is inconsistent.");
                }
            }
            StageEventBody::ArtifactUploadAttempted {
                artifact_kind,
                artifact_uri,
                payload_sha256,
                payload_bytes,
            } => {
                if allocations.get(artifact_kind) != Some(artifact_uri)
                    || uploaded.contains(artifact_kind)
                    || !is_plain_hash(payload_sha256)
                    || *payload_bytes == 0
                {
                    return Err("Staging artifact upload attempt is inconsistent.");
                }
            }
            StageEventBody::ArtifactUploadAmbiguous {
                artifact_kind,
                artifact_uri,
                payload_sha256,
                payload_bytes,
            } => {
                if !matching_upload_attempt(
                    previous,
                    artifact_kind,
                    artifact_uri,
                    payload_sha256,
                    *payload_bytes,
                ) || index + 1 != events.len()
                {
                    return Err("Ambiguous artifact upload is not terminal or matched.");
                }
            }
            StageEventBody::ArtifactUploaded {
                artifact_kind,
                artifact_uri,
                payload_sha256,
                payload_bytes,
            } => {
                if !matching_upload_attempt(
                    previous,
                    artifact_kind,
                    artifact_uri,
                    payload_sha256,
                    *payload_bytes,
                ) || !uploaded.insert(artifact_kind.clone())
                {
                    return Err("Staging artifact upload is inconsistent.");
                }
            }
            StageEventBody::ProgramRegistrationAttempted { nonce, body_sha256 } => {
                if observed_program != Some(false)
                    || !uploaded.contains("synthetic_program")
                    || registration_attempt.is_some()
                    || !is_plain_hash(body_sha256)
                {
                    return Err("Program registration attempt is out of order.");
                }
                registration_attempt = Some((*nonce, body_sha256.clone()));
            }
            StageEventBody::ProgramRegistrationAmbiguous { nonce, body_sha256 } => {
                if registration_attempt.as_ref() != Some(&(*nonce, body_sha256.clone()))
                    || index + 1 != events.len()
                {
                    return Err("Ambiguous program registration is not terminal or matched.");
                }
            }
            StageEventBody::ProgramRegistered {
                program_uri,
                transaction_hash,
            } => {
                if registration_attempt.is_none()
                    || allocations.get("synthetic_program") != Some(program_uri)
                    || registered_program.is_some()
                    || !is_prefixed_hash(transaction_hash)
                {
                    return Err("Program registration result is inconsistent.");
                }
                registered_program = Some(program_uri.clone());
            }
            StageEventBody::Complete {
                preparation_id: complete_preparation,
                requester: complete_requester,
                program_uri,
                stdin_uri,
                witness_sha256: complete_witness,
                proof_request_submitted,
            } => {
                if index + 1 != events.len()
                    || *proof_request_submitted
                    || complete_preparation != preparation_id
                    || complete_requester != requester
                    || complete_witness != witness_sha256
                    || registered_program.as_deref() != Some(program_uri)
                    || allocations.get(stdin_kind) != Some(stdin_uri)
                    || !uploaded.contains(stdin_kind)
                {
                    return Err("Staging completion is inconsistent.");
                }
            }
        }
    }
    Ok(())
}

fn validate_artifact_kind(kind: &str) -> Result<(), &'static str> {
    if matches!(
        kind,
        "synthetic_program" | "synthetic_private_stdin" | "synthetic_public_stdin"
    ) {
        Ok(())
    } else {
        Err("Staging artifact kind is unsupported.")
    }
}

fn matching_upload_attempt(
    previous: Option<&StageEvent>,
    kind: &str,
    uri: &str,
    hash: &str,
    bytes: usize,
) -> bool {
    matches!(
        previous.map(|event| &event.body),
        Some(StageEventBody::ArtifactUploadAttempted {
            artifact_kind,
            artifact_uri,
            payload_sha256,
            payload_bytes,
        }) if artifact_kind == kind
            && artifact_uri == uri
            && payload_sha256 == hash
            && *payload_bytes == bytes
    )
}

fn is_plain_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_prefixed_hash(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(is_plain_hash)
}

fn write_event(file: &mut File, event: &StageEvent) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(event).map_err(|_| "Unable to encode staging event.")?;
    file.write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|_| "Unable to append staging event.")?;
    file.sync_all()
        .map_err(|_| "Unable to flush staging event.")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn event_encoding_rejects_unknown_fields() {
        let invalid = r#"{"schemaVersion":1,"atUnix":1,"operationId":"x","event":"intent","preparationId":"p","requester":"r","elfSha256":"e","witnessSha256":"w","proofRequestAllowed":false,"extra":true}"#;
        assert!(serde_json::from_str::<StageEvent>(invalid).is_err());
    }

    #[test]
    fn journal_rejects_proof_permission() {
        let event = StageEvent {
            schema_version: 1,
            at_unix: 1,
            operation_id: format!("0x{}", "11".repeat(32)),
            body: StageEventBody::Intent {
                preparation_id: "preparation".into(),
                requester: "requester".into(),
                elf_sha256: "22".repeat(32),
                witness_sha256: "33".repeat(32),
                proof_request_allowed: true,
                public_disclosure: None,
            },
        };
        assert!(validate(&[event]).is_err());
    }

    #[test]
    fn completed_private_witness_staging_sequence_is_valid() {
        let operation_id = format!("0x{}", "11".repeat(32));
        let wrap = |at_unix, body| StageEvent {
            schema_version: 1,
            at_unix,
            operation_id: operation_id.clone(),
            body,
        };
        let events = vec![
            wrap(
                1,
                StageEventBody::Intent {
                    preparation_id: "preparation".into(),
                    requester: "requester".into(),
                    elf_sha256: "22".repeat(32),
                    witness_sha256: "33".repeat(32),
                    proof_request_allowed: false,
                    public_disclosure: None,
                },
            ),
            wrap(
                2,
                StageEventBody::ProgramObserved {
                    registered: true,
                    program_uri: Some("program-uri".into()),
                },
            ),
            wrap(
                3,
                StageEventBody::ArtifactAllocationAttempted {
                    artifact_kind: "synthetic_private_stdin".into(),
                },
            ),
            wrap(
                4,
                StageEventBody::ArtifactAllocated {
                    artifact_kind: "synthetic_private_stdin".into(),
                    artifact_uri: "stdin-uri".into(),
                },
            ),
            wrap(
                5,
                StageEventBody::ArtifactUploadAttempted {
                    artifact_kind: "synthetic_private_stdin".into(),
                    artifact_uri: "stdin-uri".into(),
                    payload_sha256: "44".repeat(32),
                    payload_bytes: 1,
                },
            ),
            wrap(
                6,
                StageEventBody::ArtifactUploaded {
                    artifact_kind: "synthetic_private_stdin".into(),
                    artifact_uri: "stdin-uri".into(),
                    payload_sha256: "44".repeat(32),
                    payload_bytes: 1,
                },
            ),
            wrap(
                7,
                StageEventBody::Complete {
                    preparation_id: "preparation".into(),
                    requester: "requester".into(),
                    program_uri: "program-uri".into(),
                    stdin_uri: "stdin-uri".into(),
                    witness_sha256: "33".repeat(32),
                    proof_request_submitted: false,
                },
            ),
        ];
        assert!(validate(&events).is_ok());
    }
}
