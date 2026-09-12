//! Synthetic-only program registration and witness upload.

use crate::{
    direct::{encode_artifact, encoded_message_sha256, DirectNetwork},
    journal::{self, StageEvent, StageEventBody, STAGING_SUFFIX},
    read_preparation, sha256_hex, unix_time,
};
use serde::Deserialize;
use sp1_sdk::{
    network::{
        proto::{artifact::ArtifactType, types::CreateProgramRequestBody},
        signer::NetworkSigner,
        NetworkClient, NetworkMode, B256,
    },
    Elf, HashableKey, Prover, ProverClient, ProvingKey, SP1Stdin,
};
use std::{env, path::Path};
use ultratokenizer_claim_evidence::{
    request::{Request, MAX_REQUEST_BYTES},
    verify_claim, ClaimInput, MAX_DOCUMENT_BYTES,
};
use ultratokenizer_network_request_schema::{
    normalize_address, read_private_bounded, require_suffix, Preparation, ReviewedSynthetic,
    EXPECTED_PROGRAM_VKEY,
};

const FIXTURE_PDF: &[u8] =
    include_bytes!("../../claim-evidence/fixtures/gold-certificate.synthetic.pdf");
const FIXTURE_REQUEST: &[u8] =
    include_bytes!("../../claim-evidence/fixtures/request.synthetic.json");
const FIXTURE_METADATA: &str =
    include_str!("../../claim-evidence/fixtures/gold-certificate.synthetic.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureMetadata {
    signer_fingerprint: String,
}

pub fn inspect(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[1], STAGING_SUFFIX)?;
    let events = journal::read(Path::new(&args[1]))?;
    let Some(StageEvent {
        operation_id,
        body:
            StageEventBody::Complete {
                preparation_id,
                requester,
                program_uri,
                stdin_uri,
                proof_request_submitted,
                ..
            },
        ..
    }) = events.last()
    else {
        return Err("Staging journal is valid but incomplete; do not rerun its external writes.");
    };
    if *proof_request_submitted {
        return Err("Staging journal unexpectedly reports a proof request.");
    }
    println!(
        "{}",
        serde_json::json!({
            "status":"synthetic_artifacts_staged",
            "operationId":operation_id,
            "preparationId":preparation_id,
            "requester":requester,
            "eventCount":events.len(),
            "programUriSha256":sha256_hex(program_uri.as_bytes()),
            "stdinUriSha256":sha256_hex(stdin_uri.as_bytes()),
            "proofRequestSubmitted":false,
        })
    );
    Ok(())
}

pub async fn run(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[4], STAGING_SUFFIX)?;
    let preparation = read_preparation(&args[1])?;
    let expected_requester = normalize_address(&args[2])?;
    let elf_bytes = crate::read_bounded(&args[3], 32 * 1024 * 1024)?;
    if sha256_hex(&elf_bytes) != preparation.elf_sha256 {
        return Err("ELF does not match the preparation journal.");
    }

    let witness = load_witness(&preparation, args)?;

    let light = ProverClient::builder().light().build().await;
    let key = light
        .setup(Elf::from(elf_bytes.clone()))
        .await
        .map_err(|_| "Synthetic guest setup failed.")?;
    if key.verifying_key().bytes32() != EXPECTED_PROGRAM_VKEY {
        return Err("ELF program key does not match the synthetic V2 pin.");
    }

    let private_key = env::var("NETWORK_PRIVATE_KEY")
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or("NETWORK_PRIVATE_KEY is required for external staging.")?;
    let signer = NetworkSigner::local(&private_key)
        .map_err(|_| "NETWORK_PRIVATE_KEY is not a valid requester key.")?;
    let requester = format!("{:#x}", signer.address()).to_ascii_lowercase();
    if requester != expected_requester {
        return Err("Requester key does not match the explicitly authorized address.");
    }

    let operation_id = crate::operation_id(&preparation.preparation_id, &requester);
    let journal_path = Path::new(&args[4]);
    journal::create(
        journal_path,
        &event(
            &operation_id,
            StageEventBody::Intent {
                preparation_id: preparation.preparation_id.clone(),
                requester: requester.clone(),
                elf_sha256: preparation.elf_sha256.clone(),
                witness_sha256: preparation.witness_sha256.clone(),
                proof_request_allowed: false,
            },
        )?,
    )?;

    let rpc_url = sp1_sdk::network::get_default_rpc_url_for_mode(NetworkMode::Mainnet);
    let read_client = NetworkClient::new(signer.clone(), rpc_url.clone(), NetworkMode::Mainnet);
    let direct = DirectNetwork::connect(signer, &rpc_url).await?;
    let vk_hash = program_hash()?;
    let observed = read_client
        .get_program(vk_hash)
        .await
        .map_err(|_| "Unable to read synthetic program registration status.")?;
    journal::append(
        journal_path,
        &event(
            &operation_id,
            StageEventBody::ProgramObserved {
                registered: observed.is_some(),
                program_uri: observed
                    .as_ref()
                    .map(|entry| entry.program_uri().to_owned()),
            },
        )?,
    )?;

    let program_uri = if let Some(program) = observed {
        let uri = program.program_uri().to_owned();
        if uri.is_empty() {
            return Err("Succinct returned a malformed registered program.");
        }
        uri
    } else {
        register_program(
            &preparation,
            &elf_bytes,
            key.verifying_key(),
            &read_client,
            &direct,
            journal_path,
            &operation_id,
            vk_hash,
        )
        .await?
    };

    let mut stdin = SP1Stdin::new();
    stdin.write_vec(witness);
    let stdin_payload = encode_artifact(&stdin)?;
    let stdin_uri = stage_artifact_once(
        &direct,
        journal_path,
        &operation_id,
        "synthetic_private_stdin",
        ArtifactType::PrivateStdin,
        stdin_payload,
    )
    .await?;
    journal::append(
        journal_path,
        &event(
            &operation_id,
            StageEventBody::Complete {
                preparation_id: preparation.preparation_id.clone(),
                requester: requester.clone(),
                program_uri,
                stdin_uri,
                witness_sha256: preparation.witness_sha256.clone(),
                proof_request_submitted: false,
            },
        )?,
    )?;

    let events = journal::read(journal_path)?;
    let Some(StageEvent {
        body:
            StageEventBody::Complete {
                stdin_uri,
                proof_request_submitted,
                ..
            },
        ..
    }) = events.last()
    else {
        return Err("Staging journal did not reach its complete state.");
    };
    if *proof_request_submitted {
        return Err("Staging journal unexpectedly reports a proof request.");
    }
    println!(
        "{}",
        serde_json::json!({
            "status":"synthetic_artifacts_staged",
            "operationId":operation_id,
            "preparationId":preparation.preparation_id,
            "requester":requester,
            "programRegistered":true,
            "stdinUriSha256":sha256_hex(stdin_uri.as_bytes()),
            "proofRequestSubmitted":false,
        })
    );
    Ok(())
}

fn load_witness(preparation: &Preparation, args: &[String]) -> Result<Vec<u8>, &'static str> {
    preparation.validate_synthetic()?;
    if args[0] == "stage-reviewed-synthetic" {
        let review = preparation
            .reviewed_synthetic
            .as_ref()
            .ok_or("This command requires a reviewed synthetic preparation.")?;
        let review_hash = preparation
            .review_manifest_sha256
            .as_deref()
            .ok_or("Missing reviewed synthetic manifest hash.")?;
        let bytes = read_private_bounded(&args[5], 64 * 1024)?;
        if args[6] != review_hash || sha256_hex(&bytes) != review_hash {
            return Err("Review manifest differs from the preparation or explicit authorization.");
        }
        let supplied: ReviewedSynthetic =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid reviewed synthetic manifest.")?;
        if &supplied != review {
            return Err("Review manifest differs from the sealed preparation.");
        }
        let pdf = read_private_bounded(&args[7], MAX_DOCUMENT_BYTES)?;
        let request = read_private_bounded(&args[8], MAX_REQUEST_BYTES)?;
        review.validate_files(&pdf, &request)?;
        let mut signer = [0; 32];
        hex::decode_to_slice(&review.signer_fingerprint, &mut signer)
            .map_err(|_| "Invalid synthetic signer fingerprint.")?;
        verify_witness(preparation, &pdf, &request, signer, unix_time()?)
    } else {
        if preparation.reviewed_synthetic.is_some() {
            return Err(
                "Reviewed preparations require explicit review, PDF and request input paths.",
            );
        }
        let metadata: FixtureMetadata =
            serde_json::from_str(FIXTURE_METADATA).map_err(|_| "Invalid synthetic metadata.")?;
        let mut signer = [0; 32];
        hex::decode_to_slice(&metadata.signer_fingerprint, &mut signer)
            .map_err(|_| "Invalid synthetic signer fingerprint.")?;
        verify_witness(
            preparation,
            FIXTURE_PDF,
            FIXTURE_REQUEST,
            signer,
            unix_time()?,
        )
    }
}

fn verify_witness(
    preparation: &Preparation,
    pdf: &[u8],
    request_bytes: &[u8],
    approved_signer: [u8; 32],
    now: u64,
) -> Result<Vec<u8>, &'static str> {
    if sha256_hex(pdf) != preparation.pdf_sha256
        || sha256_hex(request_bytes) != preparation.request_json_sha256
    {
        return Err("Synthetic source or request differs from the sealed preparation.");
    }
    let request = Request::from_json(request_bytes).map_err(|_| "Invalid synthetic request.")?;
    let input = ClaimInput {
        approved_signer,
        request_json: request_bytes,
        pdf_bytes: pdf,
    };
    let expected = verify_claim(&input).map_err(|_| "Synthetic claim failed verification.")?;
    if let Some(review) = &preparation.reviewed_synthetic {
        let address = |word: &[u8; 32]| format!("0x{}", hex::encode(&word[12..]));
        if request.valid_until <= now
            || request.chain_id != ultratokenizer_claim_evidence::request::word_u64(296)
            || address(&request.gate) != review.gate
            || address(&request.token) != review.token
            || address(&request.recipient) != review.recipient
            || format!("0x{}", hex::encode(request.issuer_id)) != review.issuer_id
            || format!("0x{}", hex::encode(expected.source_id)) != review.source_id
            || request.amount
                != ultratokenizer_claim_evidence::request::word_u64(
                    review
                        .amount_milligrams
                        .parse()
                        .map_err(|_| "Invalid reviewed amount.")?,
                )
            || format!("0x{}", hex::encode(request.digest())) != review.request_digest
        {
            return Err("Verified claim differs from the authorized deployment and recipient.");
        }
    }
    let witness = input
        .encode()
        .map_err(|_| "Synthetic witness encoding failed.")?;
    if sha256_hex(&witness) != preparation.witness_sha256
        || witness.len() != preparation.witness_bytes
        || format!("0x{}", hex::encode(request.digest())) != preparation.request_digest
        || format!("0x{}", hex::encode(expected.public_values())) != preparation.public_values
        || sha256_hex(&expected.public_values()) != preparation.public_values_sha256
    {
        return Err("Synthetic witness does not match the preparation journal.");
    }
    Ok(witness)
}

#[allow(clippy::too_many_arguments)]
async fn register_program(
    preparation: &Preparation,
    elf_bytes: &[u8],
    verifying_key: &sp1_sdk::SP1VerifyingKey,
    read_client: &NetworkClient,
    direct: &DirectNetwork,
    journal_path: &Path,
    operation_id: &str,
    vk_hash: B256,
) -> Result<String, &'static str> {
    let program_payload = encode_artifact(&elf_bytes)?;
    let program_uri = stage_artifact_once(
        direct,
        journal_path,
        operation_id,
        "synthetic_program",
        ArtifactType::Program,
        program_payload,
    )
    .await?;

    let nonce = read_client
        .get_nonce()
        .await
        .map_err(|_| "Unable to read requester nonce for program registration.")?;
    let body = CreateProgramRequestBody {
        nonce,
        vk_hash: vk_hash.to_vec(),
        vk: bincode::serialize(verifying_key)
            .map_err(|_| "Unable to encode synthetic verification key.")?,
        program_uri: program_uri.clone(),
    };
    let body_sha256 = encoded_message_sha256(&body);
    journal::append(
        journal_path,
        &event(
            operation_id,
            StageEventBody::ProgramRegistrationAttempted {
                nonce,
                body_sha256: body_sha256.clone(),
            },
        )?,
    )?;
    let response = match direct.create_program_once(body).await {
        Ok(response) => response,
        Err(error) => {
            journal::append(
                journal_path,
                &event(
                    operation_id,
                    StageEventBody::ProgramRegistrationAmbiguous { nonce, body_sha256 },
                )?,
            )?;
            return Err(error);
        }
    };
    if response.tx_hash.len() != 32 {
        return Err("Succinct returned a malformed program transaction hash.");
    }
    journal::append(
        journal_path,
        &event(
            operation_id,
            StageEventBody::ProgramRegistered {
                program_uri: program_uri.clone(),
                transaction_hash: format!("0x{}", hex::encode(response.tx_hash)),
            },
        )?,
    )?;
    let registered = read_client
        .get_program(vk_hash)
        .await
        .map_err(|_| "Unable to confirm synthetic program registration.")?
        .ok_or("Synthetic program registration was not observable.")?;
    if registered.program_uri() != program_uri {
        return Err("Observed synthetic program URI does not match the uploaded ELF.");
    }
    if preparation.program_v_key != EXPECTED_PROGRAM_VKEY {
        return Err("Preparation program key changed during staging.");
    }
    Ok(program_uri)
}

async fn stage_artifact_once(
    direct: &DirectNetwork,
    journal_path: &Path,
    operation_id: &str,
    artifact_kind: &str,
    artifact_type: ArtifactType,
    payload: Vec<u8>,
) -> Result<String, &'static str> {
    journal::append(
        journal_path,
        &event(
            operation_id,
            StageEventBody::ArtifactAllocationAttempted {
                artifact_kind: artifact_kind.into(),
            },
        )?,
    )?;
    let allocation = match direct.allocate_artifact_once(artifact_type).await {
        Ok(allocation) => allocation,
        Err(error) => {
            journal::append(
                journal_path,
                &event(
                    operation_id,
                    StageEventBody::ArtifactAllocationAmbiguous {
                        artifact_kind: artifact_kind.into(),
                    },
                )?,
            )?;
            return Err(error);
        }
    };
    journal::append(
        journal_path,
        &event(
            operation_id,
            StageEventBody::ArtifactAllocated {
                artifact_kind: artifact_kind.into(),
                artifact_uri: allocation.uri.clone(),
            },
        )?,
    )?;

    let payload_sha256 = sha256_hex(&payload);
    let payload_bytes = payload.len();
    journal::append(
        journal_path,
        &event(
            operation_id,
            StageEventBody::ArtifactUploadAttempted {
                artifact_kind: artifact_kind.into(),
                artifact_uri: allocation.uri.clone(),
                payload_sha256: payload_sha256.clone(),
                payload_bytes,
            },
        )?,
    )?;
    if let Err(error) = direct.upload_artifact_once(&allocation, payload).await {
        journal::append(
            journal_path,
            &event(
                operation_id,
                StageEventBody::ArtifactUploadAmbiguous {
                    artifact_kind: artifact_kind.into(),
                    artifact_uri: allocation.uri.clone(),
                    payload_sha256,
                    payload_bytes,
                },
            )?,
        )?;
        return Err(error);
    }
    journal::append(
        journal_path,
        &event(
            operation_id,
            StageEventBody::ArtifactUploaded {
                artifact_kind: artifact_kind.into(),
                artifact_uri: allocation.uri.clone(),
                payload_sha256,
                payload_bytes,
            },
        )?,
    )?;
    Ok(allocation.uri)
}

fn event(operation_id: &str, body: StageEventBody) -> Result<StageEvent, &'static str> {
    Ok(StageEvent {
        schema_version: 1,
        at_unix: unix_time()?,
        operation_id: operation_id.into(),
        body,
    })
}

fn program_hash() -> Result<B256, &'static str> {
    let raw = EXPECTED_PROGRAM_VKEY
        .strip_prefix("0x")
        .ok_or("Pinned program key is malformed.")?;
    let bytes = hex::decode(raw).map_err(|_| "Pinned program key is malformed.")?;
    if bytes.len() != 32 {
        return Err("Pinned program key is malformed.");
    }
    Ok(B256::from_slice(&bytes))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use ultratokenizer_network_request_schema::{
        EXPECTED_FIXTURE_PDF_SHA256, EXPECTED_FIXTURE_REQUEST_SHA256,
        EXPECTED_OUTER_CIRCUIT_VERSION,
    };

    fn fixture() -> (Preparation, [u8; 32]) {
        let metadata: FixtureMetadata = serde_json::from_str(FIXTURE_METADATA).unwrap();
        let mut signer = [0; 32];
        hex::decode_to_slice(metadata.signer_fingerprint, &mut signer).unwrap();
        let input = ClaimInput {
            approved_signer: signer,
            request_json: FIXTURE_REQUEST,
            pdf_bytes: FIXTURE_PDF,
        };
        let verified = verify_claim(&input).unwrap();
        let witness = input.encode().unwrap();
        let preparation = Preparation {
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
            witness_sha256: sha256_hex(&witness),
            witness_bytes: witness.len(),
            request_json_sha256: EXPECTED_FIXTURE_REQUEST_SHA256.into(),
            pdf_sha256: EXPECTED_FIXTURE_PDF_SHA256.into(),
            request_digest: format!("0x{}", hex::encode(verified.request_digest)),
            public_values: format!("0x{}", hex::encode(verified.public_values())),
            public_values_sha256: sha256_hex(&verified.public_values()),
            cycle_limit: 300,
            gas_limit_pgu: 400,
            sp1_sdk_version: "6.2.4".into(),
            outer_circuit_version: EXPECTED_OUTER_CIRCUIT_VERSION.into(),
            network_upload_occurred: false,
            proof_request_submitted: false,
            reviewed_synthetic: None,
            review_manifest_sha256: None,
        }
        .seal();
        (preparation, signer)
    }

    #[test]
    fn legacy_preparations_round_trip_without_new_fields_or_changed_identity() {
        let (preparation, _) = fixture();
        let json = serde_json::to_string(&preparation).unwrap();
        assert!(!json.contains("reviewedSynthetic"));
        assert!(!json.contains("reviewManifestSha256"));
        let decoded: Preparation = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.preparation_id, preparation.preparation_id);
        decoded.validate_synthetic().unwrap();
        assert_eq!(decoded.computed_id(), preparation.computed_id());
    }

    #[test]
    fn staging_rederives_exact_witness_and_rejects_mutated_seals_before_credentials() {
        let (preparation, signer) = fixture();
        let witness =
            verify_witness(&preparation, FIXTURE_PDF, FIXTURE_REQUEST, signer, 1).unwrap();
        assert_eq!(sha256_hex(&witness), preparation.witness_sha256);
        for field in 0..6 {
            let mut changed = preparation.clone();
            match field {
                0 => changed.witness_sha256 = "99".repeat(32),
                1 => changed.witness_bytes += 1,
                2 => changed.public_values_sha256 = "99".repeat(32),
                3 => changed.public_values = format!("0x{}", "99".repeat(224)),
                4 => changed.request_digest = format!("0x{}", "99".repeat(32)),
                _ => changed.pdf_sha256 = "99".repeat(32),
            }
            assert!(
                verify_witness(&changed.seal(), FIXTURE_PDF, FIXTURE_REQUEST, signer, 1).is_err()
            );
        }
        assert!(
            verify_witness(&preparation, &FIXTURE_PDF[1..], FIXTURE_REQUEST, signer, 1).is_err()
        );
        assert!(
            verify_witness(&preparation, FIXTURE_PDF, &FIXTURE_REQUEST[1..], signer, 1).is_err()
        );
        assert!(verify_witness(&preparation, FIXTURE_PDF, FIXTURE_REQUEST, [0; 32], 1).is_err());
        assert!(load_witness(&preparation, &["stage-reviewed-synthetic".into()]).is_err());
    }
    #[test]
    fn authenticated_reviewed_binding_rejects_each_substitution_and_expiry() {
        // Exercise the reviewed comparison with a genuinely authenticated embedded
        // claim. This fixture is NOT the separately allowlisted deployment PDF;
        // full stage admission still rejects it via validate_synthetic/validate_files.
        let (mut preparation, signer) = fixture();
        let request = Request::from_json(FIXTURE_REQUEST).unwrap();
        let input = ClaimInput {
            approved_signer: signer,
            request_json: FIXTURE_REQUEST,
            pdf_bytes: FIXTURE_PDF,
        };
        let expected = verify_claim(&input).unwrap();
        let address = |word: &[u8; 32]| format!("0x{}", hex::encode(&word[12..]));
        preparation.reviewed_synthetic = Some(ReviewedSynthetic {
            schema_version: 1,
            purpose: "authorized-synthetic-testnet-proof".into(),
            source_kind: "synthetic-signed-pdf-capsule".into(),
            synthetic: true,
            production_approved: false,
            chain_id: "296".into(),
            gate: address(&request.gate),
            token: address(&request.token),
            recipient: address(&request.recipient),
            issuer_id: format!("0x{}", hex::encode(request.issuer_id)),
            source_id: format!("0x{}", hex::encode(expected.source_id)),
            amount_milligrams: "10000".into(),
            signer_fingerprint: hex::encode(signer),
            pdf_sha256: preparation.pdf_sha256.clone(),
            request_json_sha256: preparation.request_json_sha256.clone(),
            request_digest: preparation.request_digest.clone(),
        });
        let now = request.valid_until - 1;
        assert!(verify_witness(&preparation, FIXTURE_PDF, FIXTURE_REQUEST, signer, now).is_ok());
        for field in 0..7 {
            let mut changed = preparation.clone();
            let review = changed.reviewed_synthetic.as_mut().unwrap();
            match field {
                0 => review.gate = format!("0x{}", "99".repeat(20)),
                1 => review.token = format!("0x{}", "99".repeat(20)),
                2 => review.recipient = format!("0x{}", "99".repeat(20)),
                3 => review.issuer_id = format!("0x{}", "99".repeat(32)),
                4 => review.source_id = format!("0x{}", "99".repeat(32)),
                5 => review.amount_milligrams = "999".into(),
                _ => review.request_digest = format!("0x{}", "99".repeat(32)),
            }
            assert_eq!(
                verify_witness(&changed, FIXTURE_PDF, FIXTURE_REQUEST, signer, now).unwrap_err(),
                "Verified claim differs from the authorized deployment and recipient."
            );
        }
        for now in [request.valid_until, request.valid_until + 1] {
            assert!(
                verify_witness(&preparation, FIXTURE_PDF, FIXTURE_REQUEST, signer, now).is_err()
            );
        }
        assert!(load_witness(&preparation.seal(), &["stage-reviewed-synthetic".into()]).is_err());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn reviewed_stage_rejects_substituted_artifacts_before_key_loading_or_journal_creation() {
        use std::os::unix::fs::PermissionsExt;
        use ultratokenizer_network_request_schema::{
            REVIEWED_PREPARATION_SCHEMA_VERSION, REVIEWED_SYNTHETIC_KIND,
            REVIEWED_SYNTHETIC_PDF_SHA256, REVIEWED_SYNTHETIC_REQUEST_DIGEST,
            REVIEWED_SYNTHETIC_REQUEST_SHA256, REVIEWED_SYNTHETIC_SIGNER,
        };
        let directory =
            std::env::temp_dir().join(format!("ut-reviewed-stage-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let write = |name: &str, data: &[u8]| {
            let path = directory.join(name);
            std::fs::write(&path, data).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            path.to_str().unwrap().to_string()
        };
        let (mut preparation, _) = fixture();
        let review = ReviewedSynthetic {
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
        };
        let review_bytes = serde_json::to_vec(&review).unwrap();
        let review_hash = sha256_hex(&review_bytes);
        let fake_elf = [0_u8; 100];
        preparation.schema_version = REVIEWED_PREPARATION_SCHEMA_VERSION;
        preparation.fixture_kind = REVIEWED_SYNTHETIC_KIND.into();
        preparation.elf_sha256 = sha256_hex(&fake_elf);
        preparation.pdf_sha256.clone_from(&review.pdf_sha256);
        preparation
            .request_json_sha256
            .clone_from(&review.request_json_sha256);
        preparation
            .request_digest
            .clone_from(&review.request_digest);
        preparation.reviewed_synthetic = Some(review);
        preparation.review_manifest_sha256 = Some(review_hash.clone());
        preparation = preparation.seal();
        preparation.validate_synthetic().unwrap();
        let journal = directory.join("stage.sp1-network-staging.jsonl");
        let args = vec![
            "stage-reviewed-synthetic".into(),
            write(
                "input.sp1-network-preparation.json",
                &serde_json::to_vec(&preparation).unwrap(),
            ),
            format!("0x{}", "11".repeat(20)),
            write("guest.elf", &fake_elf),
            journal.to_str().unwrap().into(),
            write("review.json", &review_bytes),
            review_hash,
            write("substituted.pdf", FIXTURE_PDF),
            write("substituted.json", FIXTURE_REQUEST),
        ];
        let expected = preparation
            .reviewed_synthetic
            .as_ref()
            .unwrap()
            .validate_files(FIXTURE_PDF, FIXTURE_REQUEST)
            .unwrap_err();
        // No environment access or live SP1 operation is necessary for this rejection.
        assert_eq!(run(&args).await.unwrap_err(), expected);
        assert!(!journal.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
