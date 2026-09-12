//! Fail-closed preparation and quoting for one synthetic SP1 Network proof.
//!
//! This module deliberately has no generic document input. It can encode only the
//! repository fixture or an explicitly hash-pinned, allowlisted synthetic PDF.
//! Preparation does not upload artifacts or submit a proof request.

use super::{local_proof, read_bounded, MAX_CYCLES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sp1_sdk::{Elf, HashableKey, Prover, ProverClient, ProvingKey, SP1Stdin};
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use ultratokenizer_claim_evidence::{
    request::{Request, MAX_REQUEST_BYTES},
    verify_claim, ClaimInput, VerifiedClaim, MAX_DOCUMENT_BYTES, PROFILE_VERSION,
    PUBLIC_VALUES_BYTES,
};
use ultratokenizer_network_request_schema::{
    read_private_bounded, require_suffix, Preparation, ReviewedSynthetic,
    EXPECTED_FIXTURE_PDF_SHA256, EXPECTED_FIXTURE_REQUEST_SHA256, EXPECTED_OUTER_CIRCUIT_VERSION,
    EXPECTED_PROGRAM_VKEY, PREPARATION_SCHEMA_VERSION, PREPARATION_SUFFIX,
    REVIEWED_PREPARATION_SCHEMA_VERSION, REVIEWED_SYNTHETIC_KIND,
};

const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const EXPECTED_PROGRAM: &str = "ultratokenizer-claim-guest";
const EXPECTED_PROFILE: &str = "ultratokenizer-synthetic-gold-v2";
const EXPECTED_SOURCE_KIND: &str = "synthetic-signed-pdf-capsule";
const EXPECTED_AMOUNT_PREDICATE: &str = "request.amount == authenticated capacityMilligrams";

const FIXTURE_PDF: &[u8] =
    include_bytes!("../../claim-evidence/fixtures/gold-certificate.synthetic.pdf");
const FIXTURE_REQUEST: &[u8] =
    include_bytes!("../../claim-evidence/fixtures/request.synthetic.json");
const FIXTURE_METADATA: &str =
    include_str!("../../claim-evidence/fixtures/gold-certificate.synthetic.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgramManifest {
    manifest_version: u32,
    program: String,
    profile: String,
    profile_version: u32,
    public_values_bytes: usize,
    source_kind: String,
    test_only: bool,
    production_approved: bool,
    amount_predicate: String,
    program_v_key: String,
    elf_sha256: String,
    outer_circuit_version: String,
    tooling: ManifestTooling,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTooling {
    sp1_sdk_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureMetadata {
    synthetic: bool,
    signer_fingerprint: String,
    file_sha256: String,
    public_values: String,
    profile: String,
    request_digest: String,
}

pub async fn run(args: &[String]) -> Result<(), &'static str> {
    match args.first().map(String::as_str) {
        Some("network-prepare-synthetic") if args.len() == 4 => prepare(args).await,
        Some("network-prepare-reviewed-synthetic") if args.len() == 8 => prepare(args).await,
        Some("network-prepare-reviewed-synthetic") => Err(
            "Usage: claim-runner network-prepare-reviewed-synthetic <elf> <program-manifest-json> <review-json> <review-sha256> <synthetic-pdf> <request-json> <new-preparation-file>",
        ),
        Some("network-prepare-synthetic") => Err(
            "Usage: claim-runner network-prepare-synthetic <elf> <program-manifest-json> <new-preparation-file>",
        ),
        _ => Err("Unsupported SP1 Network command."),
    }
}

async fn prepare(args: &[String]) -> Result<(), &'static str> {
    local_proof::check_runtime()?;
    let reviewed = args[0] == "network-prepare-reviewed-synthetic";
    let output = &args[if reviewed { 7 } else { 3 }];
    require_suffix(output, PREPARATION_SUFFIX)?;

    let manifest_bytes = read_bounded(&args[2], MAX_MANIFEST_BYTES)?;
    let manifest: ProgramManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "Invalid program manifest.")?;
    validate_manifest(&manifest)?;

    let metadata: FixtureMetadata =
        serde_json::from_str(FIXTURE_METADATA).map_err(|_| "Invalid synthetic metadata.")?;
    let (pdf, request_bytes, review, review_hash) = if reviewed {
        let bytes = read_private_bounded(&args[3], MAX_MANIFEST_BYTES)?;
        if !is_lower_hex(&args[4], 32, false) || sha256_hex(&bytes) != args[4] {
            return Err("Review manifest does not match its independently supplied hash.");
        }
        let review: ReviewedSynthetic = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid reviewed synthetic input manifest.")?;
        review.validate()?;
        let pdf = read_private_bounded(&args[5], MAX_DOCUMENT_BYTES)?;
        let request_bytes = read_private_bounded(&args[6], MAX_REQUEST_BYTES)?;
        review.validate_files(&pdf, &request_bytes)?;
        (pdf, request_bytes, Some(review), Some(args[4].clone()))
    } else {
        validate_fixture_metadata(&metadata)?;
        (FIXTURE_PDF.to_vec(), FIXTURE_REQUEST.to_vec(), None, None)
    };

    let elf_bytes = read_bounded(&args[1], 32 * 1024 * 1024)?;
    let elf_sha256 = sha256_hex(&elf_bytes);
    if elf_sha256 != manifest.elf_sha256 {
        return Err("ELF does not match the reviewed synthetic manifest.");
    }

    let mut approved_signer = [0; 32];
    hex::decode_to_slice(
        review
            .as_ref()
            .map_or(metadata.signer_fingerprint.as_str(), |value| {
                value.signer_fingerprint.as_str()
            }),
        &mut approved_signer,
    )
    .map_err(|_| "Invalid synthetic signer fingerprint.")?;
    let request = Request::from_json(&request_bytes).map_err(|_| "Invalid synthetic request.")?;
    let input = ClaimInput {
        approved_signer,
        request_json: &request_bytes,
        pdf_bytes: &pdf,
    };
    let expected =
        verify_claim(&input).map_err(|_| "Embedded synthetic claim failed verification.")?;
    let request_digest = format!("0x{}", hex::encode(request.digest()));
    if let Some(review) = &review {
        validate_reviewed_bindings(review, &request, &expected)?;
    } else if format!("0x{}", hex::encode(expected.public_values())) != metadata.public_values
        || format!("0x{}", hex::encode(request.digest())) != metadata.request_digest
    {
        return Err("Synthetic metadata does not match verified claim output.");
    }

    let witness = input
        .encode()
        .map_err(|_| "Synthetic witness encoding failed.")?;
    let client = ProverClient::builder().light().build().await;
    let key = client
        .setup(Elf::from(elf_bytes.clone()))
        .await
        .map_err(|_| "Synthetic guest setup failed.")?;
    if key.verifying_key().bytes32() != manifest.program_v_key {
        return Err("ELF program key does not match the reviewed manifest.");
    }
    let mut stdin = SP1Stdin::new();
    stdin.write_vec(witness.clone());
    let (values, report) = client
        .execute(Elf::from(elf_bytes.clone()), stdin)
        .cycle_limit(MAX_CYCLES)
        .calculate_gas(true)
        .await
        .map_err(|_| "Synthetic SP1 execution or gas measurement failed.")?;
    if report.exit_code != 0 || values.as_slice() != expected.public_values() {
        return Err("Synthetic guest output did not match native verification.");
    }
    local_proof::check_public_values(&request, values.as_slice())?;
    let gas_limit_pgu = report
        .gas()
        .ok_or("SP1 did not return a PGU measurement.")?;
    let created_at_unix = unix_time()?;
    let preparation = Preparation {
        schema_version: if reviewed {
            REVIEWED_PREPARATION_SCHEMA_VERSION
        } else {
            PREPARATION_SCHEMA_VERSION
        },
        status: "prepared_no_upload".into(),
        preparation_id: String::new(),
        created_at_unix,
        network: "succinct-mainnet".into(),
        proof_mode: "groth16".into(),
        fixture_kind: if reviewed {
            REVIEWED_SYNTHETIC_KIND
        } else {
            "embedded-reviewed-synthetic-v2"
        }
        .into(),
        program_manifest_sha256: sha256_hex(&manifest_bytes),
        program_v_key: manifest.program_v_key,
        elf_sha256,
        elf_bytes: elf_bytes.len(),
        witness_sha256: sha256_hex(&witness),
        witness_bytes: witness.len(),
        request_json_sha256: sha256_hex(&request_bytes),
        pdf_sha256: sha256_hex(&pdf),
        request_digest,
        public_values: format!("0x{}", hex::encode(values.as_slice())),
        public_values_sha256: sha256_hex(values.as_slice()),
        cycle_limit: report.total_instruction_count(),
        gas_limit_pgu,
        sp1_sdk_version: manifest.tooling.sp1_sdk_version,
        outer_circuit_version: manifest.outer_circuit_version,
        network_upload_occurred: false,
        proof_request_submitted: false,
        reviewed_synthetic: review,
        review_manifest_sha256: review_hash,
    }
    .seal();
    preparation.validate_synthetic()?;
    write_json_new(Path::new(output), &preparation)?;
    println!(
        "{}",
        serde_json::json!({
            "status": preparation.status,
            "preparationId": preparation.preparation_id,
            "cycleLimit": preparation.cycle_limit,
            "gasLimitPgu": preparation.gas_limit_pgu,
            "networkUploadOccurred": false,
            "proofRequestSubmitted": false,
        })
    );
    Ok(())
}

fn validate_reviewed_bindings(
    review: &ReviewedSynthetic,
    request: &Request,
    claim: &VerifiedClaim,
) -> Result<(), &'static str> {
    let address = |word: &[u8; 32]| format!("0x{}", hex::encode(&word[12..]));
    if request.valid_until <= unix_time()?
        || request.chain_id != ultratokenizer_claim_evidence::request::word_u64(296)
        || address(&request.gate) != review.gate
        || address(&request.token) != review.token
        || address(&request.recipient) != review.recipient
        || format!("0x{}", hex::encode(request.issuer_id)) != review.issuer_id
        || format!("0x{}", hex::encode(claim.source_id)) != review.source_id
        || request.amount != ultratokenizer_claim_evidence::request::word_u64(1000)
        || format!("0x{}", hex::encode(request.digest())) != review.request_digest
    {
        return Err("Verified claim differs from the authorized deployment and recipient.");
    }
    Ok(())
}

fn validate_manifest(manifest: &ProgramManifest) -> Result<(), &'static str> {
    if manifest.manifest_version != 1
        || manifest.program != EXPECTED_PROGRAM
        || manifest.profile != EXPECTED_PROFILE
        || manifest.profile_version != PROFILE_VERSION
        || manifest.public_values_bytes != PUBLIC_VALUES_BYTES
        || manifest.source_kind != EXPECTED_SOURCE_KIND
        || !manifest.test_only
        || manifest.production_approved
        || manifest.amount_predicate != EXPECTED_AMOUNT_PREDICATE
        || manifest.program_v_key != EXPECTED_PROGRAM_VKEY
        || manifest.outer_circuit_version != EXPECTED_OUTER_CIRCUIT_VERSION
        || manifest.tooling.sp1_sdk_version != "6.2.4"
        || !is_lower_hex(&manifest.elf_sha256, 32, false)
    {
        return Err("Program manifest is not the reviewed synthetic V2 profile.");
    }
    Ok(())
}

fn validate_fixture_metadata(metadata: &FixtureMetadata) -> Result<(), &'static str> {
    if !metadata.synthetic
        || metadata.profile != EXPECTED_PROFILE
        || metadata.file_sha256 != EXPECTED_FIXTURE_PDF_SHA256
        || sha256_hex(FIXTURE_PDF) != EXPECTED_FIXTURE_PDF_SHA256
        || sha256_hex(FIXTURE_REQUEST) != EXPECTED_FIXTURE_REQUEST_SHA256
        || !is_lower_hex(&metadata.signer_fingerprint, 32, false)
        || !is_lower_hex(&metadata.public_values, PUBLIC_VALUES_BYTES, true)
        || !is_lower_hex(&metadata.request_digest, 32, true)
    {
        return Err("Embedded fixture is not the reviewed synthetic V2 input.");
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
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

fn write_json_new<T: Serialize>(path: &Path, value: &T) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Unable to encode journal.")?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Journal already exists or cannot be created.")?;
    file.write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|_| "Unable to write journal.")?;
    file.sync_all().map_err(|_| "Unable to flush journal.")
}

fn unix_time() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "System clock is before the Unix epoch.")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn sample_preparation() -> Preparation {
        Preparation {
            schema_version: 1,
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
            public_values: format!("0x{}", "55".repeat(PUBLIC_VALUES_BYTES)),
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
    fn exact_fixture_and_manifest_are_pinned() {
        assert_eq!(sha256_hex(FIXTURE_PDF), EXPECTED_FIXTURE_PDF_SHA256);
        assert_eq!(sha256_hex(FIXTURE_REQUEST), EXPECTED_FIXTURE_REQUEST_SHA256);
        let metadata: FixtureMetadata = serde_json::from_str(FIXTURE_METADATA).unwrap();
        assert!(validate_fixture_metadata(&metadata).is_ok());
    }

    #[test]
    fn preparation_id_detects_mutation_and_external_state() {
        let mut value = sample_preparation();
        let original = value.preparation_id.clone();
        value.gas_limit_pgu += 1;
        assert_ne!(value.computed_id(), original);
        value.gas_limit_pgu -= 1;
        value.network_upload_occurred = true;
        assert_ne!(value.computed_id(), original);
    }

    #[test]
    fn journal_path_is_fail_closed() {
        assert!(require_suffix("preparation.json", PREPARATION_SUFFIX).is_err());
        assert!(require_suffix("run.sp1-network-preparation.json", PREPARATION_SUFFIX).is_ok());
    }

    #[test]
    fn reviewed_bindings_reject_each_changed_deployment_field() {
        let metadata: FixtureMetadata = serde_json::from_str(FIXTURE_METADATA).unwrap();
        let mut signer = [0; 32];
        hex::decode_to_slice(metadata.signer_fingerprint, &mut signer).unwrap();
        let claim = verify_claim(&ClaimInput {
            approved_signer: signer,
            request_json: FIXTURE_REQUEST,
            pdf_bytes: FIXTURE_PDF,
        })
        .unwrap();
        let mut request = Request::from_json(FIXTURE_REQUEST).unwrap();
        request.amount = ultratokenizer_claim_evidence::request::word_u64(1000);
        let review = ReviewedSynthetic {
            schema_version: 1,
            purpose: "authorized-synthetic-testnet-proof".into(),
            source_kind: "synthetic-signed-pdf-capsule".into(),
            synthetic: true,
            production_approved: false,
            chain_id: "296".into(),
            gate: format!("0x{}", hex::encode(&request.gate[12..])),
            token: format!("0x{}", hex::encode(&request.token[12..])),
            recipient: format!("0x{}", hex::encode(&request.recipient[12..])),
            issuer_id: format!("0x{}", hex::encode(request.issuer_id)),
            source_id: format!("0x{}", hex::encode(claim.source_id)),
            amount_milligrams: "1000".into(),
            signer_fingerprint: ultratokenizer_network_request_schema::REVIEWED_SYNTHETIC_SIGNER
                .into(),
            pdf_sha256: ultratokenizer_network_request_schema::REVIEWED_SYNTHETIC_PDF_SHA256.into(),
            request_json_sha256: "66".repeat(32),
            request_digest: format!("0x{}", hex::encode(request.digest())),
        };
        assert!(validate_reviewed_bindings(&review, &request, &claim).is_ok());
        for field in 0..8 {
            let mut changed = request.clone();
            let mut changed_claim = claim.clone();
            match field {
                0 => changed.chain_id[31] ^= 1,
                1 => changed.gate[31] ^= 1,
                2 => changed.token[31] ^= 1,
                3 => changed.recipient[31] ^= 1,
                4 => changed.issuer_id[31] ^= 1,
                5 => changed_claim.source_id[31] ^= 1,
                6 => changed.amount[31] ^= 1,
                _ => changed.nonce[31] ^= 1,
            }
            assert!(validate_reviewed_bindings(&review, &changed, &changed_claim).is_err());
        }
    }
}
