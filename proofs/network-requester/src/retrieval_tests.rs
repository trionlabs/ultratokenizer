//! Synthetic network/container fixtures, never positive cryptographic proof evidence.
#![allow(clippy::unwrap_used)]

use super::*;
use crate::paid_rpc::PaidSigner;
use crate::paid_state::{Plan, Settings};
use prost::Message;
use std::collections::VecDeque;

fn admission() -> OriginAdmission {
    OriginAdmission {
        format: "ultratokenizer.reviewed-artifact-origin.v1".into(),
        origin: "https://artifacts.fixture.invalid".into(),
        evidence_sha256: "11".repeat(32),
        maximum_bytes: 4096,
    }
}

/// The committed words a preparation and its returned proof must share: the
/// profile version, then the request digest, then filler for the rest.
fn committed_values() -> Vec<u8> {
    let mut values = vec![0x55; 224];
    values[..32].fill(0);
    values[31] = 2;
    values[32..64].fill(0x44);
    values
}

fn proof_fixture() -> SP1ProofWithPublicValues {
    let values = sp1_sdk::SP1PublicValues::from(&committed_values());
    let mut proof = SP1ProofWithPublicValues::new(
        SP1Proof::Groth16(Default::default()),
        values,
        EXPECTED_OUTER_CIRCUIT_VERSION.into(),
    );
    let mut encoded = vec![0_u8; 352];
    encoded[32..64].copy_from_slice(&hex::decode(VK_ROOT).unwrap());
    let mut digest = Sha256::digest(proof.public_values.as_slice()).to_vec();
    digest[0] &= 0x1f;
    let SP1Proof::Groth16(wrapped) = &mut proof.proof else {
        unreachable!();
    };
    wrapped
        .groth16_vkey_hash
        .copy_from_slice(&hex::decode(GROTH16_VERIFIER_HASH).unwrap());
    wrapped.encoded_proof = hex::encode(&encoded);
    wrapped.public_inputs = [
        U256::from_be_slice(&decode_prefixed(EXPECTED_PROGRAM_VKEY).unwrap()).to_string(),
        U256::from_be_slice(&digest).to_string(),
        "0".into(),
        U256::from_be_slice(&encoded[32..64]).to_string(),
        "0".into(),
    ];
    proof
}

fn normalize_fixture(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), &'static str> {
    let values = committed_values();
    normalize(
        bytes,
        &format!("0x{}", hex::encode(&values)),
        &sha256(&values),
        EXPECTED_PROGRAM_VKEY,
    )
}

#[test]
fn origin_admission_is_exact_and_never_inferred_from_a_returned_uri() {
    let selected = admission();
    selected.validate().unwrap();
    assert!(selected
        .admit("https://artifacts.fixture.invalid/proof?signature=private")
        .is_ok());
    for value in [
        "http://artifacts.fixture.invalid/proof",
        "https://other.fixture.invalid/proof",
        "https://artifacts.fixture.invalid:444/proof",
        "https://user@artifacts.fixture.invalid/proof",
        "https://artifacts.fixture.invalid/proof#fragment",
        "https://127.0.0.1/proof",
        "https://[::1]/proof",
        "s3://spn-artifacts-mainnet/proof",
        "https://artifacts.fixture.invalid.evil.invalid/proof",
    ] {
        assert!(selected.admit(value).is_err(), "{value}");
    }
    let mut invalid = selected.clone();
    invalid.origin.push('/');
    assert!(invalid.validate().is_err());
    invalid = selected.clone();
    invalid.maximum_bytes = MAX_ARTIFACT_BYTES + 1;
    assert!(invalid.validate().is_err());
    invalid = selected;
    invalid.evidence_sha256 = "00".repeat(32);
    assert!(invalid.validate().is_err());
}

struct Response {
    status: u16,
    url: String,
    length: Option<u64>,
    encoding: Option<String>,
    chunks: VecDeque<Result<Vec<u8>, &'static str>>,
    reads: usize,
}
impl ArtifactResponse for Response {
    fn status(&self) -> u16 {
        self.status
    }
    fn url(&self) -> &str {
        &self.url
    }
    fn length(&self) -> Option<u64> {
        self.length
    }
    fn encoding(&self) -> Result<Option<&str>, &'static str> {
        Ok(self.encoding.as_deref())
    }
    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, &'static str> {
        self.reads += 1;
        self.chunks.pop_front().transpose()
    }
}
struct Transport {
    response: Option<Response>,
    calls: usize,
}
impl Transport {
    fn response(chunks: Vec<Vec<u8>>) -> Self {
        Self {
            response: Some(Response {
                status: 200,
                url: "https://artifacts.fixture.invalid/proof".into(),
                length: None,
                encoding: None,
                chunks: chunks.into_iter().map(Ok).collect(),
                reads: 0,
            }),
            calls: 0,
        }
    }
}
impl ArtifactTransport for Transport {
    type Response = Response;
    async fn get_once(&mut self, _: &Url) -> Result<Response, &'static str> {
        self.calls += 1;
        self.response
            .take()
            .ok_or("fixture received an unexpected retry")
    }
}

#[tokio::test]
async fn stream_limit_redirect_encoding_and_content_length_fail_without_retry() {
    let url = Url::parse("https://artifacts.fixture.invalid/proof").unwrap();
    let mut valid = Transport::response(vec![vec![1; 2], vec![2; 2]]);
    assert_eq!(
        download_once(&mut valid, &url, 4).await.unwrap(),
        vec![1, 1, 2, 2]
    );
    assert_eq!(valid.calls, 1);
    for change in 0..12 {
        let mut transport = Transport::response(vec![vec![1; 3], vec![2; 3]]);
        let response = transport.response.as_mut().unwrap();
        match change {
            0 => response.status = 302,
            1 => response.url = "https://other.fixture.invalid/proof".into(),
            2 => response.encoding = Some("gzip".into()),
            3 => response.length = Some(6),
            4 => response.length = Some(3),
            5 => (), // A missing Content-Length never disables the streamed ceiling.
            6 => response.chunks = vec![Ok(vec![])].into(),
            7 => response.chunks.clear(),
            8 => response.chunks = vec![Ok(vec![1]), Err("synthetic read failure")].into(),
            9 => response.length = Some(0),
            10 => response.status = 206,
            _ => {
                response.length = Some(3);
                response.chunks = vec![Ok(vec![1; 2])].into();
            }
        }
        assert!(download_once(&mut transport, &url, 4).await.is_err());
        assert_eq!(transport.calls, 1);
    }
    let mut fragmented = Transport::response(vec![vec![1]; MAX_BODY_CHUNKS + 1]);
    assert!(download_once(&mut fragmented, &url, MAX_ARTIFACT_BYTES)
        .await
        .is_err());
    assert_eq!(fragmented.calls, 1);
}

#[test]
fn actual_sdk_network_and_bundle_serialization_normalize_without_claiming_validity() {
    let proof = proof_fixture();
    let bundled = codec().serialize(&proof).unwrap();
    let (normalized, format) = normalize_fixture(&bundled).unwrap();
    assert_eq!(normalized, bundled);
    assert_eq!(format, "sp1-proof-with-public-values");
    let network = ProofFromNetwork {
        proof: proof.proof,
        public_values: proof.public_values,
        sp1_version: proof.sp1_version,
    };
    let bytes = codec().serialize(&network).unwrap();
    let (normalized, format) = normalize_fixture(&bytes).unwrap();
    assert_eq!(format, "sp1-proof-from-network");
    let decoded: SP1ProofWithPublicValues = codec().deserialize(&normalized).unwrap();
    assert!(decoded.tee_proof.is_none());
    // The all-zero pairing coordinates are deliberately invalid. Normalization is
    // only structural; no test or API calls them a cryptographically valid proof.
    let SP1Proof::Groth16(wrapped) = decoded.proof else {
        unreachable!();
    };
    assert!(hex::decode(wrapped.encoded_proof).unwrap()[96..]
        .iter()
        .all(|v| *v == 0));
}

#[test]
fn artifact_decoder_rejects_trailing_data_wrong_mode_tee_and_wrong_commitments() {
    let valid = codec().serialize(&proof_fixture()).unwrap();
    let mut trailing = valid.clone();
    trailing.push(1);
    assert!(normalize_fixture(&trailing).is_err());
    let mut mode = valid.clone();
    mode[..4].copy_from_slice(&0_u32.to_le_bytes());
    assert!(normalize_fixture(&mode).is_err());
    for change in 0..11 {
        let mut proof = proof_fixture();
        match change {
            0 => proof.tee_proof = Some(vec![]),
            1 => proof.sp1_version = "v6.0.0".into(),
            2 => proof.public_values = sp1_sdk::SP1PublicValues::from(&vec![0x56; 224]),
            _ => {
                let SP1Proof::Groth16(wrapped) = &mut proof.proof else {
                    unreachable!();
                };
                match change {
                    3 => wrapped.groth16_vkey_hash[0] ^= 1,
                    4 => wrapped.public_inputs[0] = "1".into(),
                    5 => wrapped.encoded_proof = "00".repeat(351),
                    6 => wrapped.encoded_proof.replace_range(..2, "01"),
                    7 => wrapped.encoded_proof.replace_range(64..66, "01"),
                    8 => wrapped.public_inputs[1] = "1".into(),
                    9 => wrapped.public_inputs[4] = "1".into(),
                    _ => wrapped.encoded_proof = wrapped.encoded_proof.to_uppercase(),
                }
            }
        }
        assert!(normalize_fixture(&codec().serialize(&proof).unwrap()).is_err());
    }
    // A different commitment than the fixture's: this must not normalize.
    let values = vec![0x56; 224];
    assert!(normalize(
        &valid,
        &format!("0x{}", hex::encode(&values)),
        &sha256(&values),
        &format!("0x{}", "11".repeat(32))
    )
    .is_err());
    // Removing only the trailing None byte produces the other explicitly
    // admitted SDK wire format, so truncate inside its version instead.
    for length in [0, 4, 12, valid.len() - 2] {
        assert!(normalize_fixture(&valid[..length]).is_err());
    }
    let mut hostile = 3_u32.to_le_bytes().to_vec();
    hostile.extend_from_slice(&u64::MAX.to_le_bytes());
    assert!(normalize_fixture(&hostile).is_err());
    assert!(normalize_fixture(&vec![0; MAX_ARTIFACT_BYTES as usize + 1]).is_err());
}

struct Network {
    request: rpc::ProofRequest,
    transaction: rpc::TransactionDetails,
    status: rpc::GetProofRequestStatusResponse,
    reads: usize,
}
impl PaidRpc for Network {
    async fn params(&mut self) -> Result<rpc::GetProofRequestParamsResponse, &'static str> {
        Err("retrieval must not quote")
    }
    async fn program(&mut self, _: Vec<u8>) -> Result<Option<rpc::Program>, &'static str> {
        Err("retrieval must not re-stage")
    }
    async fn balance(&mut self, _: Vec<u8>) -> Result<String, &'static str> {
        Err("retrieval must not access account balance")
    }
    async fn nonce(&mut self, _: Vec<u8>) -> Result<u64, &'static str> {
        Err("retrieval must not acquire a nonce")
    }
    async fn submit_once(
        &mut self,
        _: rpc::RequestProofRequest,
    ) -> Result<rpc::RequestProofResponse, &'static str> {
        Err("retrieval must never submit")
    }
    async fn requests(
        &mut self,
        _: rpc::GetFilteredProofRequestsRequest,
    ) -> Result<Vec<rpc::ProofRequest>, &'static str> {
        Err("retrieval must not select a new request")
    }
    async fn request(&mut self, _: Vec<u8>) -> Result<Option<rpc::ProofRequest>, &'static str> {
        self.reads += 1;
        Ok(Some(self.request.clone()))
    }
    async fn transaction(
        &mut self,
        _: Vec<u8>,
    ) -> Result<Option<rpc::TransactionDetails>, &'static str> {
        self.reads += 1;
        Ok(Some(self.transaction.clone()))
    }
    async fn status(
        &mut self,
        _: Vec<u8>,
    ) -> Result<rpc::GetProofRequestStatusResponse, &'static str> {
        self.reads += 1;
        Ok(self.status.clone())
    }
}

static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ut-retrieval-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn recovered_fixture(directory: &Directory) -> (std::path::PathBuf, String, Network) {
    use ultratokenizer_network_request_schema::{
        format_prove, Preparation, Quote, EXPECTED_FIXTURE_PDF_SHA256,
        EXPECTED_FIXTURE_REQUEST_SHA256,
    };
    let signer =
        sp1_sdk::network::signer::NetworkSigner::local(&format!("0x{}", "11".repeat(32))).unwrap();
    let requester = PaidSigner::address(&signer);
    let values = committed_values();
    let preparation = Preparation {
        schema_version: 1,
        status: "prepared_no_upload".into(),
        preparation_id: String::new(),
        created_at_unix: 999,
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
        public_values: format!("0x{}", hex::encode(&values)),
        public_values_sha256: sha256(&values),
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
    let quote = Quote {
        schema_version: 1,
        status: "quoted_no_submission".into(),
        quote_id: String::new(),
        preparation_id: preparation.preparation_id.clone(),
        observed_at_unix: 1000,
        review_valid_until_unix: 1300,
        network: "succinct-mainnet".into(),
        requester: requester.clone(),
        proof_mode: "groth16".into(),
        cycle_limit: 300,
        gas_limit_pgu: 400,
        base_fee_wei: "10".into(),
        max_price_per_pgu_wei: "1".into(),
        max_request_cost_wei: "410".into(),
        max_request_cost_prove: format_prove(410),
        requester_balance_wei: "2000".into(),
        requester_balance_sufficient: true,
        program_registered: true,
        registered_program_uri: Some("s3://fixture/programs/1".into()),
        domain: "0x12".into(),
        auctioneer: format!("0x{}", "21".repeat(20)),
        executor: format!("0x{}", "22".repeat(20)),
        verifier: format!("0x{}", "23".repeat(20)),
        treasury: format!("0x{}", "24".repeat(20)),
        network_upload_occurred: false,
        proof_request_submitted: false,
    }
    .seal();
    let plan = Plan {
        plan_id: String::new(),
        budget_id: "bb".repeat(32),
        request_identity: String::new(),
        preparation,
        settings: Settings {
            schema_version: 1,
            quote_id: quote.quote_id.clone(),
            quote_file_sha256: "ab".repeat(32),
            staging_journal_sha256: "cd".repeat(32),
            deadline_unix: 4600,
            min_auction_period_seconds: 10,
            prover_whitelist: vec![],
        },
        quote,
        program_uri: "s3://fixture/programs/1".into(),
        stdin_uri: "s3://fixture/private-stdins/1".into(),
    }
    .seal()
    .unwrap();
    let body = plan.body(7).unwrap();
    let body_bytes = body.encode_to_vec();
    let signed = rpc::RequestProofRequest {
        format: rpc::MessageFormat::Binary.into(),
        signature: PaidSigner::sign(&signer, &body_bytes).await.unwrap(),
        body: Some(body.clone()),
    };
    let signed_bytes = signed.encode_to_vec();
    let path = directory.path("fixture.sp1-network-request.jsonl");
    let mut journal = Journal::create(
        &path,
        RequestEvent::Prepared {
            plan: Box::new(plan.clone()),
        },
        1000,
    )
    .unwrap();
    for event in [
        RequestEvent::SigningIntent {
            nonce: 7,
            body_hex: hex::encode(&body_bytes),
            body_sha256: sha256(&body_bytes),
        },
        RequestEvent::Signed {
            request_hex: hex::encode(&signed_bytes),
            request_sha256: sha256(&signed_bytes),
        },
        RequestEvent::DispatchAttempted {
            request_sha256: sha256(&signed_bytes),
        },
        RequestEvent::Recovered {
            request_id: format!("0x{}", "72".repeat(32)),
            transaction_hash: format!("0x{}", "71".repeat(32)),
        },
        RequestEvent::Observed {
            request_id: format!("0x{}", "72".repeat(32)),
            transaction_hash: format!("0x{}", "71".repeat(32)),
            fulfillment_status: rpc::FulfillmentStatus::Fulfilled.into(),
            execution_status: rpc::ExecutionStatus::Executed.into(),
            proof_uri: Some("https://artifacts.fixture.invalid/proof".into()),
            proof_uri_sha256: Some(sha256(b"https://artifacts.fixture.invalid/proof")),
        },
    ] {
        journal.append(event, 1001).unwrap();
    }
    drop(journal);
    let hash = sha256(&std::fs::read(&path).unwrap());
    let network = Network {
        request: rpc::ProofRequest {
            request_id: vec![0x72; 32],
            tx_hash: vec![0x71; 32],
            requester: decode_prefixed(&requester).unwrap(),
            vk_hash: body.vk_hash,
            version: body.version,
            mode: body.mode,
            strategy: body.strategy,
            program_uri: plan.program_uri,
            stdin_uri: body.stdin_uri,
            deadline: body.deadline,
            cycle_limit: body.cycle_limit,
            gas_limit: body.gas_limit,
            min_auction_period: body.min_auction_period,
            whitelist: body.whitelist,
            base_fee: Some(body.base_fee),
            max_price_per_pgu: Some(body.max_price_per_pgu),
            stdin_private: body.stdin_private,
            ..Default::default()
        },
        transaction: rpc::TransactionDetails {
            tx_hash: vec![0x71; 32],
            request_id: Some(vec![0x72; 32]),
            sender: decode_prefixed(&requester).unwrap(),
            nonce: 7,
            signature: signed.signature,
            ..Default::default()
        },
        status: rpc::GetProofRequestStatusResponse {
            fulfillment_status: rpc::FulfillmentStatus::Fulfilled.into(),
            execution_status: rpc::ExecutionStatus::Executed.into(),
            request_tx_hash: vec![0x71; 32],
            deadline: 4600,
            fulfill_tx_hash: Some(vec![0x73; 32]),
            proof_uri: Some("https://artifacts.fixture.invalid/proof".into()),
            public_values_hash: body.public_values_hash,
            ..Default::default()
        },
        reads: 0,
    };
    (path, hash, network)
}

#[tokio::test]
async fn exact_recovered_artifact_saves_raw_and_normalized_files_as_unverified() {
    let directory = Directory::new();
    let (journal, hash, mut network) = recovered_fixture(&directory).await;
    let proof = proof_fixture();
    let bytes = codec()
        .serialize(&ProofFromNetwork {
            proof: proof.proof,
            public_values: proof.public_values,
            sp1_version: proof.sp1_version,
        })
        .unwrap();
    let mut transport = Transport::response(vec![bytes.clone()]);
    let raw = directory.path("raw.sp1-network-proof");
    let normalized = directory.path("normalized.sp1-network-proof");
    let receipt_path = directory.path("retrieval.sp1-network-submission.json");
    let result = retrieve_once(
        &journal,
        &hash,
        &admission(),
        OutputPaths {
            raw: &raw,
            normalized: &normalized,
            receipt: &receipt_path,
        },
        &mut network,
        &mut transport,
    )
    .await
    .unwrap();
    assert_eq!(result.status, "downloaded_unverified");
    assert!(!result.proof_cryptographically_verified);
    assert!(!result.independent_inclusion_verified);
    assert!(!result.budget_released);
    assert_eq!(std::fs::read(&raw).unwrap(), bytes);
    assert_eq!(
        sha256(&std::fs::read(&normalized).unwrap()),
        result.normalized_sha256
    );
    assert_eq!(network.reads, 3);
    assert_eq!(transport.calls, 1);
    assert!(!serde_json::to_string(&result).unwrap().contains("https://"));
    assert_eq!(sha256(&std::fs::read(&journal).unwrap()), hash);
    assert!(retrieve_once(
        &journal,
        &hash,
        &admission(),
        OutputPaths {
            raw: &raw,
            normalized: &normalized,
            receipt: &receipt_path
        },
        &mut network,
        &mut transport
    )
    .await
    .is_err());
    assert_eq!(transport.calls, 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&raw, &normalized, &receipt_path] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }
}

#[tokio::test]
async fn changed_journal_request_nonce_status_or_artifact_origin_prevents_get() {
    for change in 0..29 {
        let directory = Directory::new();
        let (journal, mut hash, mut network) = recovered_fixture(&directory).await;
        let mut origin = admission();
        match change {
            0 => hash = "99".repeat(32),
            1 => network.request.gas_limit += 1,
            2 => network.transaction.nonce += 1,
            3 => network.status.public_values_hash = Some(vec![0x99; 32]),
            4 => network.status.proof_uri = Some("https://other.fixture.invalid/proof".into()),
            5 => origin.origin = "https://other.fixture.invalid".into(),
            6 => network.request.request_id[0] ^= 1,
            7 => network.request.tx_hash[0] ^= 1,
            8 => network.request.requester[0] ^= 1,
            9 => network.request.vk_hash[0] ^= 1,
            10 => network.request.program_uri.push('x'),
            11 => network.request.stdin_uri.push('x'),
            12 => network.request.version.push('x'),
            13 => network.request.whitelist.push(vec![0x44; 20]),
            14 => network.request.base_fee = None,
            15 => network.request.max_price_per_pgu = None,
            16 => network.request.stdin_private = !network.request.stdin_private,
            17 => network.transaction.signature[0] ^= 1,
            18 => network.transaction.sender[0] ^= 1,
            19 => network.transaction.request_id = None,
            20 => network.transaction.tx_hash[0] ^= 1,
            21 => network.status.deadline += 1,
            22 => network.status.request_tx_hash[0] ^= 1,
            23 => network.status.fulfillment_status = 0,
            24 => network.status.execution_status = 0,
            25 => network.status.fulfill_tx_hash = None,
            26 => network.status.fulfill_tx_hash = Some(vec![0; 32]),
            27 => network.status.fulfill_tx_hash = Some(vec![0x73; 31]),
            _ => network.status.public_values_hash = None,
        }
        let mut transport = Transport::response(vec![codec().serialize(&proof_fixture()).unwrap()]);
        let raw = directory.path("raw.sp1-network-proof");
        let normalized = directory.path("normalized.sp1-network-proof");
        let receipt = directory.path("retrieval.sp1-network-submission.json");
        assert!(retrieve_once(
            &journal,
            &hash,
            &origin,
            OutputPaths {
                raw: &raw,
                normalized: &normalized,
                receipt: &receipt
            },
            &mut network,
            &mut transport
        )
        .await
        .is_err());
        assert_eq!(transport.calls, 0);
        assert!(!raw.exists());
        assert!(!normalized.exists());
        assert!(!receipt.exists());
    }
}

#[tokio::test]
async fn latest_observation_and_locked_snapshot_are_required_before_network_reads() {
    for change in 0..4 {
        let directory = Directory::new();
        let (journal_path, _, mut network) = recovered_fixture(&directory).await;
        let mut journal = Journal::<RequestEvent>::open(&journal_path).unwrap();
        let mut observation = journal.events().last().unwrap().body.clone();
        let RequestEvent::Observed {
            fulfillment_status,
            execution_status,
            proof_uri,
            proof_uri_sha256,
            ..
        } = &mut observation
        else {
            unreachable!();
        };
        match change {
            0 => *fulfillment_status = rpc::FulfillmentStatus::Assigned.into(),
            1 => *execution_status = rpc::ExecutionStatus::Unexecuted.into(),
            2 => {
                *proof_uri = None;
                *proof_uri_sha256 = None;
            }
            _ => (),
        }
        let at = if change == 3 {
            crate::unix_time().unwrap() + 3600
        } else {
            1002
        };
        journal.append(observation, at).unwrap();
        let bytes = std::fs::read(&journal_path).unwrap();
        check_snapshot(&bytes, journal.events()).unwrap();
        assert!(check_snapshot(&bytes, &journal.events()[..journal.events().len() - 1]).is_err());
        drop(journal);
        let hash = sha256(&bytes);
        let mut transport = Transport::response(vec![codec().serialize(&proof_fixture()).unwrap()]);
        let raw = directory.path("raw.sp1-network-proof");
        let normalized = directory.path("normalized.sp1-network-proof");
        let receipt = directory.path("retrieval.sp1-network-submission.json");
        assert!(retrieve_once(
            &journal_path,
            &hash,
            &admission(),
            OutputPaths {
                raw: &raw,
                normalized: &normalized,
                receipt: &receipt
            },
            &mut network,
            &mut transport
        )
        .await
        .is_err());
        assert_eq!(network.reads, 0);
        assert_eq!(transport.calls, 0);
        assert!(!raw.exists());
        assert!(!normalized.exists());
        assert!(!receipt.exists());
    }
}

struct StalledTransport {
    calls: usize,
}
impl ArtifactTransport for StalledTransport {
    type Response = Response;
    async fn get_once(&mut self, _: &Url) -> Result<Response, &'static str> {
        self.calls += 1;
        std::future::pending().await
    }
}

#[tokio::test]
async fn retrieval_deadline_cancels_a_stalled_get_and_preserves_the_original_journal() {
    let directory = Directory::new();
    let (journal, hash, mut network) = recovered_fixture(&directory).await;
    let mut transport = StalledTransport { calls: 0 };
    let raw = directory.path("raw.sp1-network-proof");
    let normalized = directory.path("normalized.sp1-network-proof");
    let receipt = directory.path("retrieval.sp1-network-submission.json");
    let result = retrieve_with_timeout(
        &journal,
        &hash,
        &admission(),
        OutputPaths {
            raw: &raw,
            normalized: &normalized,
            receipt: &receipt,
        },
        &mut network,
        &mut transport,
        Duration::from_millis(100),
    )
    .await;
    assert!(result
        .err()
        .unwrap()
        .starts_with("Artifact retrieval deadline elapsed"));
    assert_eq!(network.reads, 3);
    assert_eq!(transport.calls, 1);
    assert!(!raw.exists());
    assert!(!normalized.exists());
    assert!(!receipt.exists());
    assert_eq!(sha256(&std::fs::read(&journal).unwrap()), hash);
    // Cancellation must release the local lock without writing an observation or replacement intent.
    assert!(Journal::<RequestEvent>::open(&journal).is_ok());
}

#[tokio::test]
async fn malformed_artifact_or_partial_save_never_produces_a_success_receipt() {
    for change in 0..3 {
        let directory = Directory::new();
        let (journal, hash, mut network) = recovered_fixture(&directory).await;
        let mut bytes = codec().serialize(&proof_fixture()).unwrap();
        if change == 0 {
            bytes.push(0);
        }
        let mut transport = Transport::response(vec![bytes]);
        let raw = directory.path("raw.sp1-network-proof");
        let normalized = if change == 1 {
            directory.path("missing/normalized.sp1-network-proof")
        } else {
            directory.path("normalized.sp1-network-proof")
        };
        let receipt = if change == 2 {
            directory.path("missing/retrieval.sp1-network-submission.json")
        } else {
            directory.path("retrieval.sp1-network-submission.json")
        };
        assert!(retrieve_once(
            &journal,
            &hash,
            &admission(),
            OutputPaths {
                raw: &raw,
                normalized: &normalized,
                receipt: &receipt
            },
            &mut network,
            &mut transport
        )
        .await
        .is_err());
        assert_eq!(transport.calls, 1);
        assert!(!receipt.exists());
        assert_eq!(raw.exists(), change != 0);
        assert_eq!(normalized.exists(), change == 2);
        if raw.exists() {
            assert!(retrieve_once(
                &journal,
                &hash,
                &admission(),
                OutputPaths {
                    raw: &raw,
                    normalized: &normalized,
                    receipt: &receipt
                },
                &mut network,
                &mut transport
            )
            .await
            .is_err());
            assert_eq!(transport.calls, 1);
        }
        assert_eq!(sha256(&std::fs::read(&journal).unwrap()), hash);
    }
}
