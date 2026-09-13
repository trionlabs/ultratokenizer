//! Integrity-checked journals for a bounded synthetic SP1 Network request.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PREPARATION_SCHEMA_VERSION: u32 = 1;
pub const QUOTE_SCHEMA_VERSION: u32 = 1;
pub const PREPARATION_SUFFIX: &str = ".sp1-network-preparation.json";
pub const QUOTE_SUFFIX: &str = ".sp1-network-quote.json";
pub const MAX_JOURNAL_BYTES: usize = 128 * 1024;
pub const EXPECTED_PROGRAM_VKEY: &str =
    "0x00f5835ca3afad96f154badb88e8586c108ff97e13785796696c674121c79b75";
pub const EXPECTED_FIXTURE_PDF_SHA256: &str =
    "42d19a36134e2864b64568bffc230c74f10f7329d30a2bfb75ef8634cee07f66";
pub const EXPECTED_FIXTURE_REQUEST_SHA256: &str =
    "707757f3ffb9808da6bf1707103b336e29f54f31b0cf2e720fcbe95d390f2f81";
pub const EXPECTED_OUTER_CIRCUIT_VERSION: &str = "v6.1.0";
pub const REVIEWED_PREPARATION_SCHEMA_VERSION: u32 = 2;
pub const REVIEWED_SYNTHETIC_KIND: &str = "reviewed-synthetic-deployment-v2";
/// An explicitly authorized, locally generated test PDF; this is not a generic upload route.
pub const REVIEWED_SYNTHETIC_PDF_SHA256: &str =
    "44dc648ff3a8ab338ffe2a2857fb44668fc8917db292ab25fa384efb2d59bffa";
pub const REVIEWED_SYNTHETIC_SIGNER: &str =
    "dab715c9d49c43851ab892db3d6a55f7f47d5685570cf340658567ab19fe113f";
/// Authorization pins for the complete reviewed request, independent of CLI input.
/// A new deployment/recipient/request requires a separately reviewed pin update.
pub const REVIEWED_SYNTHETIC_REQUEST_SHA256: &str =
    "4d253684ba080af2a2486634ba97017666796384595ec084c624a551c9869ead";
pub const REVIEWED_SYNTHETIC_REQUEST_DIGEST: &str =
    "0xb3b67a75f974e694aa08d76a4fa7b6627e6392b79946b60e2e41d3734a03a29e";

/// Closed demo batch. Request nonces and expiries may vary only within this explicitly
/// selected deployment. The service authenticates holder consent before side effects;
/// preparation/staging independently verify the signed PDF and complete request binding.
pub const DEMO_JOB_GATE: &str = "0xe1e3a133335dc0feeb20397163c16e69f74919e3";
pub const DEMO_JOB_TOKEN: &str = "0xa77e8a964606ce6994bd8d876445218da3f9e64f";
pub const DEMO_JOB_SIGNER: &str =
    "563a7d6493ac97c193e8f2fec36006ac3c73e61ee51fab5a40d4e4ca293c0157";
pub const DEMO_JOB_PDFS: [&str; 10] = [
    "d347db1afccd252908ce07fe3e068a1d5c448ee578ab1606c55739ed32862616",
    "bc0a401d156c3558634041558f23f8bf65f120a9e1bb1294a2e5ae7b634ef733",
    "6bb6d5964b3be698b665c1f47a3817cc82fe52b449b12746f652b69782df5d3f",
    "24819ae010a712d5d0548af9f2c3807d86446496327e386cc909a4eaa24ef00a",
    "bc4bfbf34335b3b09bcd457d845acf3f73cdfddfe021249cd18843f2724847c2",
    "6bb73fd6878800c9a4460fec5b9c4077e0824e7119567bdd84dc9a523205aa8a",
    "992af1b6d369be71846eb8e00c9703835783443f358b940ced4699e5cd745c44",
    "595483b171e2214304251ce54b07e540702f03d14ef6d3fdab6a833bffbc89de",
    "9a261180c0124cde2e307a2236baebc0a6375a9c6ff40a719aba8e2d34bfa2a5",
    "89d1387faf907afa86a83747d86958ec4c500272efade779cc56b86177182883",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedSynthetic {
    pub schema_version: u32,
    pub purpose: String,
    pub source_kind: String,
    pub synthetic: bool,
    pub production_approved: bool,
    pub chain_id: String,
    pub gate: String,
    pub token: String,
    pub recipient: String,
    pub issuer_id: String,
    pub source_id: String,
    pub amount_milligrams: String,
    pub signer_fingerprint: String,
    pub pdf_sha256: String,
    pub request_json_sha256: String,
    pub request_digest: String,
}

impl ReviewedSynthetic {
    pub fn validate(&self) -> Result<(), &'static str> {
        let authorized_input = match self.schema_version {
            1 => {
                self.purpose == "authorized-synthetic-testnet-proof"
                    && self.signer_fingerprint == REVIEWED_SYNTHETIC_SIGNER
                    && self.pdf_sha256 == REVIEWED_SYNTHETIC_PDF_SHA256
                    && self.request_json_sha256 == REVIEWED_SYNTHETIC_REQUEST_SHA256
                    && self.request_digest == REVIEWED_SYNTHETIC_REQUEST_DIGEST
            }
            2 => {
                self.purpose == "authorized-synthetic-demo-job-proof"
                    && self.signer_fingerprint == DEMO_JOB_SIGNER
                    && DEMO_JOB_PDFS.contains(&self.pdf_sha256.as_str())
                    && self.gate == DEMO_JOB_GATE
                    && self.token == DEMO_JOB_TOKEN
            }
            _ => false,
        };
        if !authorized_input
            || self.source_kind != "synthetic-signed-pdf-capsule"
            || !self.synthetic
            || self.production_approved
            || self.chain_id != "296"
            || self.gate != normalize_address(&self.gate)?
            || self.token != normalize_address(&self.token)?
            || self.recipient != normalize_address(&self.recipient)?
            || self.gate == self.token
            || !is_lower_hex(&self.issuer_id, 32, true)
            || !is_lower_hex(&self.source_id, 32, true)
            || self.amount_milligrams != "1000"
            || !is_lower_hex(&self.request_json_sha256, 32, false)
            || !is_lower_hex(&self.request_digest, 32, true)
        {
            return Err("Review is not the authorized synthetic testnet input.");
        }
        Ok(())
    }

    fn commitment(&self) -> String {
        hash_fields(
            b"ultratokenizer-reviewed-synthetic-v1",
            &[
                &self.schema_version.to_be_bytes(),
                self.purpose.as_bytes(),
                self.source_kind.as_bytes(),
                if self.synthetic { b"1" } else { b"0" },
                if self.production_approved { b"1" } else { b"0" },
                self.chain_id.as_bytes(),
                self.gate.as_bytes(),
                self.token.as_bytes(),
                self.recipient.as_bytes(),
                self.issuer_id.as_bytes(),
                self.source_id.as_bytes(),
                self.amount_milligrams.as_bytes(),
                self.signer_fingerprint.as_bytes(),
                self.pdf_sha256.as_bytes(),
                self.request_json_sha256.as_bytes(),
                self.request_digest.as_bytes(),
            ],
        )
    }

    pub fn validate_files(&self, pdf: &[u8], request: &[u8]) -> Result<(), &'static str> {
        self.validate()?;
        if hex::encode(Sha256::digest(pdf)) != self.pdf_sha256
            || hex::encode(Sha256::digest(request)) != self.request_json_sha256
        {
            return Err("Input bytes differ from the authorized synthetic review.");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preparation {
    pub schema_version: u32,
    pub status: String,
    pub preparation_id: String,
    pub created_at_unix: u64,
    pub network: String,
    pub proof_mode: String,
    pub fixture_kind: String,
    pub program_manifest_sha256: String,
    pub program_v_key: String,
    pub elf_sha256: String,
    pub elf_bytes: usize,
    pub witness_sha256: String,
    pub witness_bytes: usize,
    pub request_json_sha256: String,
    pub pdf_sha256: String,
    pub request_digest: String,
    pub public_values: String,
    pub public_values_sha256: String,
    pub cycle_limit: u64,
    pub gas_limit_pgu: u64,
    pub sp1_sdk_version: String,
    pub outer_circuit_version: String,
    pub network_upload_occurred: bool,
    pub proof_request_submitted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_synthetic: Option<ReviewedSynthetic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_manifest_sha256: Option<String>,
}

impl Preparation {
    #[must_use]
    pub fn seal(mut self) -> Self {
        self.preparation_id = self.computed_id();
        self
    }

    #[must_use]
    pub fn computed_id(&self) -> String {
        let legacy = hash_fields(
            b"ultratokenizer-sp1-network-preparation-v1",
            &[
                &self.schema_version.to_be_bytes(),
                self.status.as_bytes(),
                &self.created_at_unix.to_be_bytes(),
                self.network.as_bytes(),
                self.proof_mode.as_bytes(),
                self.fixture_kind.as_bytes(),
                self.program_manifest_sha256.as_bytes(),
                self.program_v_key.as_bytes(),
                self.elf_sha256.as_bytes(),
                &u64::try_from(self.elf_bytes)
                    .unwrap_or(u64::MAX)
                    .to_be_bytes(),
                self.witness_sha256.as_bytes(),
                &u64::try_from(self.witness_bytes)
                    .unwrap_or(u64::MAX)
                    .to_be_bytes(),
                self.request_json_sha256.as_bytes(),
                self.pdf_sha256.as_bytes(),
                self.request_digest.as_bytes(),
                self.public_values.as_bytes(),
                self.public_values_sha256.as_bytes(),
                &self.cycle_limit.to_be_bytes(),
                &self.gas_limit_pgu.to_be_bytes(),
                self.sp1_sdk_version.as_bytes(),
                self.outer_circuit_version.as_bytes(),
                if self.network_upload_occurred {
                    b"1"
                } else {
                    b"0"
                },
                if self.proof_request_submitted {
                    b"1"
                } else {
                    b"0"
                },
            ],
        );
        match (&self.reviewed_synthetic, &self.review_manifest_sha256) {
            (None, None) => legacy,
            (review, hash) => hash_fields(
                b"ultratokenizer-sp1-network-preparation-v2",
                &[
                    legacy.as_bytes(),
                    review
                        .as_ref()
                        .map(ReviewedSynthetic::commitment)
                        .unwrap_or_default()
                        .as_bytes(),
                    hash.as_deref().unwrap_or("").as_bytes(),
                ],
            ),
        }
    }

    pub fn validate_synthetic(&self) -> Result<(), &'static str> {
        let valid_input = match (&self.reviewed_synthetic, &self.review_manifest_sha256) {
            (None, None) => {
                self.schema_version == PREPARATION_SCHEMA_VERSION
                    && self.fixture_kind == "embedded-reviewed-synthetic-v2"
                    && self.request_json_sha256 == EXPECTED_FIXTURE_REQUEST_SHA256
                    && self.pdf_sha256 == EXPECTED_FIXTURE_PDF_SHA256
            }
            (Some(review), Some(hash)) => {
                self.schema_version == REVIEWED_PREPARATION_SCHEMA_VERSION
                    && self.fixture_kind == REVIEWED_SYNTHETIC_KIND
                    && review.validate().is_ok()
                    && is_lower_hex(hash, 32, false)
                    && self.pdf_sha256 == review.pdf_sha256
                    && self.request_json_sha256 == review.request_json_sha256
                    && self.request_digest == review.request_digest
            }
            _ => false,
        };
        if !valid_input
            || self.status != "prepared_no_upload"
            || self.network != "succinct-mainnet"
            || self.proof_mode != "groth16"
            || self.program_v_key != EXPECTED_PROGRAM_VKEY
            || !is_lower_hex(&self.elf_sha256, 32, false)
            || !is_lower_hex(&self.program_manifest_sha256, 32, false)
            || !is_lower_hex(&self.witness_sha256, 32, false)
            || !is_lower_hex(&self.public_values_sha256, 32, false)
            || !is_lower_hex(&self.request_digest, 32, true)
            || !is_lower_hex(&self.public_values, 224, true)
            || self.sp1_sdk_version != "6.2.4"
            || self.outer_circuit_version != EXPECTED_OUTER_CIRCUIT_VERSION
            || self.network_upload_occurred
            || self.proof_request_submitted
            || self.elf_bytes == 0
            || self.witness_bytes == 0
            || self.gas_limit_pgu == 0
            || self.cycle_limit == 0
            || self.preparation_id != self.computed_id()
        {
            return Err("SP1 Network preparation journal failed integrity checks.");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quote {
    pub schema_version: u32,
    pub status: String,
    pub quote_id: String,
    pub preparation_id: String,
    pub observed_at_unix: u64,
    pub review_valid_until_unix: u64,
    pub network: String,
    pub requester: String,
    pub proof_mode: String,
    pub cycle_limit: u64,
    pub gas_limit_pgu: u64,
    pub base_fee_wei: String,
    pub max_price_per_pgu_wei: String,
    pub max_request_cost_wei: String,
    pub max_request_cost_prove: String,
    pub requester_balance_wei: String,
    pub requester_balance_sufficient: bool,
    pub program_registered: bool,
    pub registered_program_uri: Option<String>,
    pub domain: String,
    pub auctioneer: String,
    pub executor: String,
    pub verifier: String,
    pub treasury: String,
    pub network_upload_occurred: bool,
    pub proof_request_submitted: bool,
}

impl Quote {
    #[must_use]
    pub fn seal(mut self) -> Self {
        self.quote_id = self.computed_id();
        self
    }

    #[must_use]
    pub fn computed_id(&self) -> String {
        hash_fields(
            b"ultratokenizer-sp1-network-quote-v1",
            &[
                &self.schema_version.to_be_bytes(),
                self.status.as_bytes(),
                self.preparation_id.as_bytes(),
                &self.observed_at_unix.to_be_bytes(),
                &self.review_valid_until_unix.to_be_bytes(),
                self.network.as_bytes(),
                self.requester.as_bytes(),
                self.proof_mode.as_bytes(),
                &self.cycle_limit.to_be_bytes(),
                &self.gas_limit_pgu.to_be_bytes(),
                self.base_fee_wei.as_bytes(),
                self.max_price_per_pgu_wei.as_bytes(),
                self.max_request_cost_wei.as_bytes(),
                self.max_request_cost_prove.as_bytes(),
                self.requester_balance_wei.as_bytes(),
                if self.requester_balance_sufficient {
                    b"1"
                } else {
                    b"0"
                },
                if self.program_registered { b"1" } else { b"0" },
                self.registered_program_uri
                    .as_deref()
                    .unwrap_or("")
                    .as_bytes(),
                self.domain.as_bytes(),
                self.auctioneer.as_bytes(),
                self.executor.as_bytes(),
                self.verifier.as_bytes(),
                self.treasury.as_bytes(),
                if self.network_upload_occurred {
                    b"1"
                } else {
                    b"0"
                },
                if self.proof_request_submitted {
                    b"1"
                } else {
                    b"0"
                },
            ],
        )
    }

    pub fn validate(&self, preparation: &Preparation) -> Result<(), &'static str> {
        let base_fee = parse_canonical_u64(&self.base_fee_wei)?;
        let price = parse_canonical_u64(&self.max_price_per_pgu_wei)?;
        let expected_cost = maximum_cost(self.gas_limit_pgu, base_fee, price)?;
        if self.schema_version != QUOTE_SCHEMA_VERSION
            || self.status != "quoted_no_submission"
            || self.preparation_id != preparation.preparation_id
            || self.network != "succinct-mainnet"
            || self.proof_mode != "groth16"
            || self.requester != normalize_address(&self.requester)?
            || self.cycle_limit != preparation.cycle_limit
            || self.gas_limit_pgu != preparation.gas_limit_pgu
            || self.review_valid_until_unix <= self.observed_at_unix
            || self.max_request_cost_wei != expected_cost.to_string()
            || self.max_request_cost_prove != format_prove(expected_cost)
            || self.requester_balance_sufficient
                != decimal_gte(&self.requester_balance_wei, &self.max_request_cost_wei)
            || self.program_registered != self.registered_program_uri.is_some()
            || self.registered_program_uri.as_deref() == Some("")
            || !is_lower_hex(&self.domain, self.domain.len().saturating_sub(2) / 2, true)
            || self.domain == "0x"
            || normalize_address(&self.auctioneer).is_err()
            || normalize_address(&self.executor).is_err()
            || normalize_address(&self.verifier).is_err()
            || normalize_address(&self.treasury).is_err()
            || self.network_upload_occurred
            || self.proof_request_submitted
            || self.quote_id != self.computed_id()
        {
            return Err("SP1 Network quote journal failed integrity checks.");
        }
        Ok(())
    }
}

pub fn require_suffix(path: &str, suffix: &str) -> Result<(), &'static str> {
    if !path.ends_with(suffix) {
        return Err("SP1 Network journal has an unsafe file suffix.");
    }
    Ok(())
}

/// Review and witness inputs must be bounded regular owner-only files, not links.
pub fn read_private_bounded(path: &str, maximum: usize) -> Result<Vec<u8>, &'static str> {
    use std::{fs::File, io::Read};
    let before = std::fs::symlink_metadata(path).map_err(|_| "Unable to inspect private input.")?;
    if !before.is_file() || before.len() > maximum as u64 {
        return Err("Private input must be a bounded regular file.");
    }
    let file = File::open(path).map_err(|_| "Unable to open private input.")?;
    let opened = file
        .metadata()
        .map_err(|_| "Unable to inspect opened private input.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev()
            || before.ino() != opened.ino()
            || opened.mode() & 0o077 != 0
            || opened.nlink() != 1
        {
            return Err("Private input must have owner-only permissions and no links.");
        }
    }
    if !opened.is_file() {
        return Err("Private input must be a regular file.");
    }
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read private input.")?;
    if bytes.len() > maximum {
        return Err("Private input exceeds its size limit.");
    }
    Ok(bytes)
}

pub fn parse_canonical_u64(value: &str) -> Result<u64, &'static str> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Decimal value is not canonical.");
    }
    value
        .parse::<u64>()
        .map_err(|_| "Decimal value is outside the supported range.")
}

pub fn maximum_cost(gas: u64, base_fee: u64, price: u64) -> Result<u128, &'static str> {
    u128::from(gas)
        .checked_mul(u128::from(price))
        .and_then(|variable| variable.checked_add(u128::from(base_fee)))
        .ok_or("Maximum proof request cost overflowed.")
}

#[must_use]
pub fn format_prove(wei: u128) -> String {
    const SCALE: u128 = 1_000_000_000_000_000_000;
    let whole = wei / SCALE;
    let remainder = wei % SCALE;
    if remainder == 0 {
        return whole.to_string();
    }
    let mut fraction = format!("{remainder:018}");
    while fraction.ends_with('0') {
        fraction.pop();
    }
    format!("{whole}.{fraction}")
}

#[must_use]
pub fn decimal_gte(left: &str, right: &str) -> bool {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    let left = if left.is_empty() { "0" } else { left };
    let right = if right.is_empty() { "0" } else { right };
    left.bytes().all(|byte| byte.is_ascii_digit())
        && right.bytes().all(|byte| byte.is_ascii_digit())
        && (left.len() > right.len() || (left.len() == right.len() && left >= right))
}

pub fn normalize_address(value: &str) -> Result<String, &'static str> {
    let normalized = value.to_ascii_lowercase();
    if !is_lower_hex(&normalized, 20, true)
        || normalized == "0x0000000000000000000000000000000000000000"
    {
        return Err("Address must be a nonzero 20-byte value.");
    }
    Ok(normalized)
}

fn is_lower_hex(value: &str, bytes: usize, prefixed: bool) -> bool {
    let raw = if prefixed {
        let Some(raw) = value.strip_prefix("0x") else {
            return false;
        };
        raw
    } else {
        value
    };
    raw.len() == bytes.saturating_mul(2)
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hash_fields(domain: &[u8], fields: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain);
    for field in fields {
        hash.update(u64::try_from(field.len()).unwrap_or(u64::MAX).to_be_bytes());
        hash.update(field);
    }
    format!("0x{}", hex::encode(hash.finalize()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn preparation() -> Preparation {
        Preparation {
            schema_version: PREPARATION_SCHEMA_VERSION,
            status: "prepared_no_upload".into(),
            preparation_id: String::new(),
            created_at_unix: 1,
            network: "succinct-mainnet".into(),
            proof_mode: "groth16".into(),
            fixture_kind: "embedded-reviewed-synthetic-v2".into(),
            program_manifest_sha256: "11".repeat(32),
            program_v_key: EXPECTED_PROGRAM_VKEY.into(),
            elf_sha256: "22".repeat(32),
            elf_bytes: 100,
            witness_sha256: "33".repeat(32),
            witness_bytes: 200,
            request_json_sha256: EXPECTED_FIXTURE_REQUEST_SHA256.into(),
            pdf_sha256: EXPECTED_FIXTURE_PDF_SHA256.into(),
            request_digest: format!("0x{}", "44".repeat(32)),
            public_values: format!("0x{}", "55".repeat(224)),
            public_values_sha256: "66".repeat(32),
            cycle_limit: 300,
            gas_limit_pgu: 400,
            sp1_sdk_version: "6.2.4".into(),
            outer_circuit_version: EXPECTED_OUTER_CIRCUIT_VERSION.into(),
            network_upload_occurred: false,
            proof_request_submitted: false,
            reviewed_synthetic: None,
            review_manifest_sha256: None,
        }
        .seal()
    }

    #[test]
    fn preparation_integrity_detects_mutation() {
        let mut value = preparation();
        assert!(value.validate_synthetic().is_ok());
        value.gas_limit_pgu += 1;
        assert!(value.validate_synthetic().is_err());
    }

    fn reviewed() -> ReviewedSynthetic {
        ReviewedSynthetic {
            schema_version: 1,
            purpose: "authorized-synthetic-testnet-proof".into(),
            source_kind: "synthetic-signed-pdf-capsule".into(),
            synthetic: true,
            production_approved: false,
            chain_id: "296".into(),
            gate: format!("0x{}", "11".repeat(20)),
            token: format!("0x{}", "22".repeat(20)),
            recipient: format!("0x{}", "33".repeat(20)),
            issuer_id: format!("0x{}", "44".repeat(32)),
            source_id: format!("0x{}", "55".repeat(32)),
            amount_milligrams: "1000".into(),
            signer_fingerprint: REVIEWED_SYNTHETIC_SIGNER.into(),
            pdf_sha256: REVIEWED_SYNTHETIC_PDF_SHA256.into(),
            request_json_sha256: REVIEWED_SYNTHETIC_REQUEST_SHA256.into(),
            request_digest: REVIEWED_SYNTHETIC_REQUEST_DIGEST.into(),
        }
    }

    #[test]
    fn reviewed_preparation_is_distinct_and_cannot_admit_other_documents() {
        let review = reviewed();
        assert!(review.validate().is_ok());
        let mut value = preparation();
        let legacy_id = value.preparation_id.clone();
        value.schema_version = REVIEWED_PREPARATION_SCHEMA_VERSION;
        value.fixture_kind = REVIEWED_SYNTHETIC_KIND.into();
        value.pdf_sha256.clone_from(&review.pdf_sha256);
        value
            .request_json_sha256
            .clone_from(&review.request_json_sha256);
        value.request_digest.clone_from(&review.request_digest);
        value.reviewed_synthetic = Some(review.clone());
        value.review_manifest_sha256 = Some("88".repeat(32));
        value = value.seal();
        assert!(value.validate_synthetic().is_ok());
        assert_ne!(value.preparation_id, legacy_id);
        for change in 0..8 {
            let mut changed = value.clone();
            let input = changed.reviewed_synthetic.as_mut().unwrap();
            match change {
                0 => input.synthetic = false,
                1 => input.production_approved = true,
                2 => input.chain_id = "295".into(),
                3 => input.pdf_sha256 = "99".repeat(32),
                4 => input.signer_fingerprint = "99".repeat(32),
                5 => input.amount_milligrams = "999".into(),
                6 => input.request_digest = format!("0x{}", "99".repeat(32)),
                _ => input.purpose = "private-bank-document".into(),
            }
            assert!(changed.seal().validate_synthetic().is_err());
        }
        let mut changed = value.clone();
        changed.reviewed_synthetic.as_mut().unwrap().recipient = format!("0x{}", "99".repeat(20));
        assert_ne!(changed.computed_id(), value.preparation_id);
        let mut changed = value.clone();
        changed.review_manifest_sha256 = None;
        assert!(changed.seal().validate_synthetic().is_err());
        let mut changed = value;
        changed.schema_version = PREPARATION_SCHEMA_VERSION;
        assert!(changed.seal().validate_synthetic().is_err());
        assert!(review
            .validate_files(b"not the approved PDF", b"{}")
            .is_err());
    }

    #[test]
    fn caller_cannot_reseal_a_substituted_request_as_independent_authorization() {
        for substitute_digest in [false, true] {
            let mut review = reviewed();
            if substitute_digest {
                review.request_digest = format!("0x{}", "99".repeat(32));
            } else {
                review.request_json_sha256 = "99".repeat(32);
            }
            let mut value = preparation();
            value.schema_version = REVIEWED_PREPARATION_SCHEMA_VERSION;
            value.fixture_kind = REVIEWED_SYNTHETIC_KIND.into();
            value.pdf_sha256.clone_from(&review.pdf_sha256);
            value
                .request_json_sha256
                .clone_from(&review.request_json_sha256);
            value.request_digest.clone_from(&review.request_digest);
            value.review_manifest_sha256 = Some("88".repeat(32));
            value.reviewed_synthetic = Some(review);
            assert!(value.seal().validate_synthetic().is_err());
        }
    }

    #[test]
    fn demo_job_review_admits_only_ten_pinned_inputs_and_one_deployment() {
        for pdf in DEMO_JOB_PDFS {
            let mut input = reviewed();
            input.schema_version = 2;
            input.purpose = "authorized-synthetic-demo-job-proof".into();
            input.gate = DEMO_JOB_GATE.into();
            input.token = DEMO_JOB_TOKEN.into();
            input.signer_fingerprint = DEMO_JOB_SIGNER.into();
            input.pdf_sha256 = pdf.into();
            input.request_json_sha256 = "ab".repeat(32);
            input.request_digest = format!("0x{}", "cd".repeat(32));
            assert!(input.validate().is_ok());
            let original = input.commitment();
            input.request_digest = format!("0x{}", "ef".repeat(32));
            assert!(input.validate().is_ok());
            assert_ne!(input.commitment(), original);
            for mutation in 0..9 {
                let mut changed = input.clone();
                match mutation {
                    0 => changed.pdf_sha256 = "99".repeat(32),
                    1 => changed.pdf_sha256 = REVIEWED_SYNTHETIC_PDF_SHA256.into(),
                    2 => changed.signer_fingerprint = REVIEWED_SYNTHETIC_SIGNER.into(),
                    3 => changed.gate = format!("0x{}", "11".repeat(20)),
                    4 => changed.token = format!("0x{}", "22".repeat(20)),
                    5 => changed.schema_version = 1,
                    6 => changed.schema_version = 3,
                    7 => changed.purpose = "authorized-synthetic-testnet-proof".into(),
                    _ => changed.amount_milligrams = "999".into(),
                }
                assert!(changed.validate().is_err());
            }
            assert!(input.validate_files(b"unapproved PDF", b"{}").is_err());
        }
    }

    #[test]
    #[cfg(unix)]
    fn private_inputs_reject_links_permissions_and_oversize() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory =
            std::env::temp_dir().join(format!("ut-reviewed-input-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("source");
        std::fs::write(&path, b"test").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_private_bounded(path.to_str().unwrap(), 4).unwrap(),
            b"test"
        );
        assert!(read_private_bounded(path.to_str().unwrap(), 3).is_err());
        let link = directory.join("link");
        symlink(&path, &link).unwrap();
        assert!(read_private_bounded(link.to_str().unwrap(), 4).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_private_bounded(path.to_str().unwrap(), 4).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn price_math_and_formatting_are_exact() {
        assert_eq!(maximum_cost(43_270_790, 10, 20).unwrap(), 865_415_810);
        assert_eq!(format_prove(290_000_000_000_000_000), "0.29");
        assert_eq!(
            format_prove(1_000_000_000_000_000_001),
            "1.000000000000000001"
        );
        assert!(decimal_gte("100", "099"));
        assert!(!decimal_gte("98", "99"));
        assert!(!decimal_gte("not-a-number", "1"));
    }

    #[test]
    fn paths_prices_and_addresses_fail_closed() {
        assert!(require_suffix("quote.json", QUOTE_SUFFIX).is_err());
        assert!(require_suffix("run.sp1-network-quote.json", QUOTE_SUFFIX).is_ok());
        assert!(parse_canonical_u64("01").is_err());
        assert!(parse_canonical_u64("18446744073709551616").is_err());
        assert!(normalize_address("0x0000000000000000000000000000000000000000").is_err());
        assert_eq!(
            normalize_address("0x861A853Ef0ed8cDC821ca7954A0C5c681Cd2C761").unwrap(),
            "0x861a853ef0ed8cdc821ca7954a0c5c681cd2c761"
        );
    }
}
