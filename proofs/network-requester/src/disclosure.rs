//! Explicit, hash-reviewed permission for publishing an allowlisted synthetic witness.

use crate::sha256_hex;
use serde::{Deserialize, Serialize};
use ultratokenizer_network_request_schema::{normalize_address, Preparation};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicDisclosure {
    pub schema_version: u32,
    pub purpose: String,
    pub authorized_public_disclosure: bool,
    pub preparation_id: String,
    pub requester: String,
    pub review_manifest_sha256: String,
    pub valid_until_unix: u64,
}

impl PublicDisclosure {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.purpose != "public-synthetic-sp1-control"
            || !self.authorized_public_disclosure
            || self.requester != normalize_address(&self.requester)?
            || self.valid_until_unix == 0
        {
            return Err("Explicit public synthetic disclosure authorization is required.");
        }
        crate::paid_state::lower_hash(&self.review_manifest_sha256)?;
        // Preparation IDs include the schema's own prefix; compare the entire sealed ID below.
        if self.preparation_id.is_empty() {
            return Err("Public disclosure does not identify a preparation.");
        }
        Ok(())
    }

    pub fn validate(&self, preparation: &Preparation, requester: &str) -> Result<(), &'static str> {
        self.validate_shape()?;
        preparation.validate_synthetic()?;
        let review = preparation
            .reviewed_synthetic
            .as_ref()
            .ok_or("Public staging requires an allowlisted reviewed synthetic preparation.")?;
        review.validate()?;
        if self.preparation_id != preparation.preparation_id
            || self.requester != requester
            || preparation.review_manifest_sha256.as_deref() != Some(&self.review_manifest_sha256)
            || self.valid_until_unix <= preparation.created_at_unix
        {
            return Err(
                "Public disclosure differs from the exact reviewed preparation or requester.",
            );
        }
        Ok(())
    }

    pub fn fresh(&self, now: u64) -> Result<(), &'static str> {
        if now >= self.valid_until_unix {
            return Err(
                "Public disclosure authorization expired; no upload or paid send is allowed.",
            );
        }
        Ok(())
    }
}

pub fn operation_id(
    preparation_id: &str,
    requester: &str,
    disclosure: Option<&PublicDisclosure>,
) -> Result<String, &'static str> {
    match disclosure {
        None => Ok(crate::operation_id(preparation_id, requester)),
        Some(value) => Ok(format!(
            "0x{}",
            sha256_hex(
                &serde_json::to_vec(&(
                    "ultratokenizer-public-synthetic-staging-v1",
                    preparation_id,
                    requester,
                    value,
                ))
                .map_err(|_| "Unable to identify public staging.")?
            )
        )),
    }
}

pub fn artifact_kind(disclosure: Option<&PublicDisclosure>) -> &'static str {
    if disclosure.is_some() {
        "synthetic_public_stdin"
    } else {
        "synthetic_private_stdin"
    }
}

pub fn validate_stdin_uri(uri: &str, public: bool) -> Result<(), &'static str> {
    let uri = reqwest::Url::parse(uri).map_err(|_| "Invalid staged input URI.")?;
    let segments: Vec<_> = uri
        .path_segments()
        .ok_or("Invalid staged input URI.")?
        .collect();
    let expected = if public { "stdins" } else { "private-stdins" };
    let opposite = if public { "private-stdins" } else { "stdins" };
    if !segments.contains(&expected) || segments.contains(&opposite) {
        return Err("Staged input URI differs from the explicitly reviewed visibility.");
    }
    Ok(())
}
