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
}

impl Preparation {
    #[must_use]
    pub fn seal(mut self) -> Self {
        self.preparation_id = self.computed_id();
        self
    }

    #[must_use]
    pub fn computed_id(&self) -> String {
        hash_fields(
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
        )
    }

    pub fn validate_synthetic(&self) -> Result<(), &'static str> {
        if self.schema_version != PREPARATION_SCHEMA_VERSION
            || self.status != "prepared_no_upload"
            || self.network != "succinct-mainnet"
            || self.proof_mode != "groth16"
            || self.fixture_kind != "embedded-reviewed-synthetic-v2"
            || self.program_v_key != EXPECTED_PROGRAM_VKEY
            || !is_lower_hex(&self.elf_sha256, 32, false)
            || !is_lower_hex(&self.program_manifest_sha256, 32, false)
            || !is_lower_hex(&self.witness_sha256, 32, false)
            || !is_lower_hex(&self.public_values_sha256, 32, false)
            || !is_lower_hex(&self.request_digest, 32, true)
            || !is_lower_hex(&self.public_values, 224, true)
            || self.request_json_sha256 != EXPECTED_FIXTURE_REQUEST_SHA256
            || self.pdf_sha256 != EXPECTED_FIXTURE_PDF_SHA256
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
