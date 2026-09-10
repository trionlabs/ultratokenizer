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
use ultratokenizer_claim_evidence::{verify_claim, ClaimInput};
use ultratokenizer_network_request_schema::{
    normalize_address, require_suffix, Preparation, EXPECTED_PROGRAM_VKEY,
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

    let metadata: FixtureMetadata =
        serde_json::from_str(FIXTURE_METADATA).map_err(|_| "Invalid synthetic metadata.")?;
    let mut approved_signer = [0; 32];
    hex::decode_to_slice(&metadata.signer_fingerprint, &mut approved_signer)
        .map_err(|_| "Invalid synthetic signer fingerprint.")?;
    let input = ClaimInput {
        approved_signer,
        request_json: FIXTURE_REQUEST,
        pdf_bytes: FIXTURE_PDF,
    };
    let expected =
        verify_claim(&input).map_err(|_| "Embedded synthetic claim failed verification.")?;
    let witness = input
        .encode()
        .map_err(|_| "Synthetic witness encoding failed.")?;
    if sha256_hex(&witness) != preparation.witness_sha256
        || format!("0x{}", hex::encode(expected.public_values())) != preparation.public_values
    {
        return Err("Synthetic witness does not match the preparation journal.");
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

    let light = ProverClient::builder().light().build().await;
    let key = light
        .setup(Elf::from(elf_bytes.clone()))
        .await
        .map_err(|_| "Synthetic guest setup failed.")?;
    if key.verifying_key().bytes32() != EXPECTED_PROGRAM_VKEY {
        return Err("ELF program key does not match the synthetic V2 pin.");
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
