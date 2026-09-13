//! Offline fault-injection tests. All keys, requests, URIs and network replies here are fixtures.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::paid_journal::Event;
use crate::paid_rpc::PaidSigner;
use std::{
    cell::Cell,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ultratokenizer_network_request_schema::{
    format_prove, Preparation, EXPECTED_FIXTURE_PDF_SHA256, EXPECTED_FIXTURE_REQUEST_SHA256,
    EXPECTED_OUTER_CIRCUIT_VERSION, EXPECTED_PROGRAM_VKEY,
};

const NOW: u64 = 1_000;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ut-paid-tests-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Signer {
    inner: NetworkSigner,
    calls: Cell<u32>,
}
impl Signer {
    fn fixture() -> Self {
        Self {
            inner: NetworkSigner::local(&format!("0x{}", "11".repeat(32))).unwrap(),
            calls: Cell::new(0),
        }
    }
}
impl PaidSigner for Signer {
    fn address(&self) -> String {
        PaidSigner::address(&self.inner)
    }
    async fn sign(&self, bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
        self.calls.set(self.calls.get() + 1);
        PaidSigner::sign(&self.inner, bytes).await
    }
}

fn plan(requester: &str, budget_id: &str) -> Plan {
    // The committed words must carry the profile version and the request
    // digest, exactly as a real preparation does; the schema now checks both.
    let mut public_values = vec![0x55; 224];
    public_values[..32].fill(0);
    public_values[31] = 2;
    public_values[32..64].fill(0x44);
    let preparation = Preparation {
        schema_version: 1,
        status: "prepared_no_upload".into(),
        preparation_id: String::new(),
        created_at_unix: NOW - 1,
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
        public_values: format!("0x{}", hex::encode(&public_values)),
        public_values_sha256: sha256_hex(&public_values),
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
        observed_at_unix: NOW,
        review_valid_until_unix: NOW + 300,
        network: "succinct-mainnet".into(),
        requester: requester.into(),
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
        network_vk_hash: Some(
            ultratokenizer_network_request_schema::EXPECTED_NETWORK_VK_HASH.into(),
        ),
    }
    .seal();
    Plan {
        plan_id: String::new(),
        budget_id: budget_id.into(),
        request_identity: String::new(),
        preparation,
        settings: Settings {
            schema_version: 1,
            quote_id: quote.quote_id.clone(),
            quote_file_sha256: "ab".repeat(32),
            staging_journal_sha256: "cd".repeat(32),
            deadline_unix: NOW + 3600,
            min_auction_period_seconds: 10,
            prover_whitelist: vec![],
        },
        quote,
        program_uri: "s3://fixture/programs/1".into(),
        stdin_uri: "s3://fixture/private-stdins/1".into(),
        public_disclosure: None,
        network_vk_hash: Some(
            ultratokenizer_network_request_schema::EXPECTED_NETWORK_VK_HASH.into(),
        ),
    }
    .seal()
    .unwrap()
}

fn budget(
    directory: &Directory,
    requester: &str,
    single: &str,
    total: &str,
) -> Journal<BudgetEvent> {
    Journal::create(
        &directory.path("budget.jsonl"),
        BudgetEvent::Created {
            network: "succinct-mainnet".into(),
            requester: requester.into(),
            single_cap_wei: single.into(),
            total_cap_wei: total.into(),
        },
        NOW,
    )
    .unwrap()
}

fn reserve(log: &mut Journal<BudgetEvent>, value: &Plan) {
    Budget::read(log.events())
        .unwrap()
        .can_reserve(value)
        .unwrap();
    log.append(
        BudgetEvent::Reserved {
            plan_id: value.plan_id.clone(),
            request_identity: value.request_identity.clone(),
            maximum_cost_wei: value.quote.max_request_cost_wei.clone(),
        },
        NOW,
    )
    .unwrap();
}

struct Network {
    plan: Plan,
    params_changed: bool,
    nonce_calls: u32,
    sends: Vec<rpc::RequestProofRequest>,
    ambiguous: bool,
    response: rpc::RequestProofResponse,
    candidates: Vec<rpc::ProofRequest>,
    transactions: Vec<rpc::TransactionDetails>,
    status: rpc::GetProofRequestStatusResponse,
    filters: Vec<rpc::GetFilteredProofRequestsRequest>,
    log_path: PathBuf,
    page_flood: bool,
    transaction_calls: u32,
}
impl Network {
    fn fixture(plan: &Plan, log_path: PathBuf) -> Self {
        Self {
            plan: plan.clone(),
            params_changed: false,
            nonce_calls: 0,
            sends: vec![],
            ambiguous: false,
            response: rpc::RequestProofResponse {
                tx_hash: vec![0x71; 32],
                body: Some(rpc::RequestProofResponseBody {
                    request_id: vec![0x72; 32],
                }),
            },
            candidates: vec![],
            transactions: vec![],
            filters: vec![],
            log_path,
            page_flood: false,
            transaction_calls: 0,
            status: rpc::GetProofRequestStatusResponse {
                fulfillment_status: rpc::FulfillmentStatus::Requested.into(),
                execution_status: rpc::ExecutionStatus::Unexecuted.into(),
                request_tx_hash: vec![0x71; 32],
                deadline: plan.settings.deadline_unix,
                ..Default::default()
            },
        }
    }
    fn index_sent(&mut self) {
        let signed = self.sends.last().unwrap();
        let body = signed.body.as_ref().unwrap();
        self.candidates = vec![rpc::ProofRequest {
            request_id: vec![0x72; 32],
            tx_hash: vec![0x71; 32],
            requester: decode_prefixed(&self.plan.quote.requester).unwrap(),
            vk_hash: body.vk_hash.clone(),
            version: body.version.clone(),
            mode: body.mode,
            strategy: body.strategy,
            program_uri: self.plan.program_uri.clone(),
            stdin_uri: body.stdin_uri.clone(),
            deadline: body.deadline,
            cycle_limit: body.cycle_limit,
            gas_limit: body.gas_limit,
            min_auction_period: body.min_auction_period,
            whitelist: body.whitelist.clone(),
            base_fee: Some(body.base_fee.clone()),
            max_price_per_pgu: Some(body.max_price_per_pgu.clone()),
            stdin_private: body.stdin_private,
            ..Default::default()
        }];
        self.transactions = vec![rpc::TransactionDetails {
            tx_hash: vec![0x71; 32],
            request_id: Some(vec![0x72; 32]),
            sender: decode_prefixed(&self.plan.quote.requester).unwrap(),
            nonce: body.nonce,
            signature: signed.signature.clone(),
            ..Default::default()
        }];
    }
}
impl PaidRpc for Network {
    async fn params(&mut self) -> Result<rpc::GetProofRequestParamsResponse, &'static str> {
        let body = self.plan.body(0)?;
        Ok(rpc::GetProofRequestParamsResponse {
            domain: body.domain,
            auctioneer: body.auctioneer,
            executor: body.executor,
            verifier: body.verifier,
            treasury: body.treasury,
            base_fee: if self.params_changed {
                "11".into()
            } else {
                body.base_fee
            },
            max_price_per_pgu: body.max_price_per_pgu,
        })
    }
    async fn program(&mut self, vk_hash: Vec<u8>) -> Result<Option<rpc::Program>, &'static str> {
        Ok(Some(rpc::Program {
            vk_hash,
            program_uri: self.plan.program_uri.clone(),
            ..Default::default()
        }))
    }
    async fn balance(&mut self, _: Vec<u8>) -> Result<String, &'static str> {
        Ok("2000".into())
    }
    async fn nonce(&mut self, _: Vec<u8>) -> Result<u64, &'static str> {
        self.nonce_calls += 1;
        Ok(7)
    }
    async fn submit_once(
        &mut self,
        request: rpc::RequestProofRequest,
    ) -> Result<rpc::RequestProofResponse, &'static str> {
        // The mock boundary inspects actual bytes on disk, not only in-memory state.
        let bytes = std::fs::read(&self.log_path).unwrap();
        let events: Vec<Event<RequestEvent>> = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let state = RequestState::read(&events).unwrap();
        assert!(state.dispatched);
        assert_eq!(state.signed.as_ref(), Some(&request));
        self.sends.push(request);
        if self.ambiguous {
            Err("fixture transport lost response")
        } else {
            Ok(self.response.clone())
        }
    }
    async fn requests(
        &mut self,
        filter: rpc::GetFilteredProofRequestsRequest,
    ) -> Result<Vec<rpc::ProofRequest>, &'static str> {
        let page = filter.page.unwrap_or(1);
        self.filters.push(filter);
        if self.page_flood {
            return Ok((0..100_u32)
                .map(|index| {
                    let mut candidate = self.candidates[0].clone();
                    let identity = page * 100 + index;
                    candidate.request_id[..4].copy_from_slice(&identity.to_be_bytes());
                    candidate.gas_limit += 1;
                    candidate
                })
                .collect());
        }
        Ok(self.candidates.clone())
    }
    async fn request(&mut self, id: Vec<u8>) -> Result<Option<rpc::ProofRequest>, &'static str> {
        Ok(self.candidates.iter().find(|v| v.request_id == id).cloned())
    }
    async fn transaction(
        &mut self,
        hash: Vec<u8>,
    ) -> Result<Option<rpc::TransactionDetails>, &'static str> {
        self.transaction_calls += 1;
        Ok(self
            .transactions
            .iter()
            .find(|v| v.tx_hash == hash)
            .cloned())
    }
    async fn status(
        &mut self,
        _: Vec<u8>,
    ) -> Result<rpc::GetProofRequestStatusResponse, &'static str> {
        Ok(self.status.clone())
    }
}

fn setup(directory: &Directory, signer: &Signer) -> (Plan, Journal<RequestEvent>) {
    let value = plan(&signer.address(), &"bb".repeat(32));
    value.validate().unwrap();
    let log = Journal::create(
        &directory.path("request.jsonl"),
        RequestEvent::Prepared {
            plan: Box::new(value.clone()),
        },
        NOW,
    )
    .unwrap();
    (value, log)
}

#[test]
fn positive_immutable_caps_and_cumulative_reservation_survive_restart() {
    for bad in [
        "0",
        "01",
        "-1",
        "+1",
        "1.0",
        "340282366920938463463374607431768211456",
    ] {
        assert!(positive_decimal(bad).is_err(), "{bad}");
    }
    let directory = Directory::new();
    let signer = Signer::fixture();
    let mut log = budget(&directory, &signer.address(), "500", "800");
    let first = plan(&signer.address(), &Budget::read(log.events()).unwrap().id);
    reserve(&mut log, &first);
    drop(log);
    let log = Journal::<BudgetEvent>::open(&directory.path("budget.jsonl")).unwrap();
    let current = Budget::read(log.events()).unwrap();
    assert_eq!(current.encumbered, 410);
    assert!(current.can_reserve(&first).is_err());
    let mut resealed = first.clone();
    resealed.preparation.created_at_unix -= 1;
    resealed.preparation = resealed.preparation.seal();
    resealed.quote.preparation_id = resealed.preparation.preparation_id.clone();
    resealed.quote = resealed.quote.seal();
    resealed.settings.quote_id = resealed.quote.quote_id.clone();
    let resealed = resealed.seal().unwrap();
    resealed.validate().unwrap();
    assert_ne!(resealed.plan_id, first.plan_id);
    assert!(current.can_reserve(&resealed).is_err());
    let mut second = first.clone();
    second.preparation.witness_sha256 = "42".repeat(32);
    second.preparation = second.preparation.seal();
    second.quote.preparation_id = second.preparation.preparation_id.clone();
    second.quote = second.quote.seal();
    second.settings.quote_id = second.quote.quote_id.clone();
    let second = second.seal().unwrap();
    second.validate().unwrap();
    assert!(current.can_reserve(&second).is_err()); // 410 + 410 > total 800
    assert!(current.require_reservation(&second, log.events()).is_err());
}

#[test]
fn plan_rejects_wrong_public_values_deadlines_whitelist_and_unknown_settings() {
    let valid = plan(&Signer::fixture().address(), &"bb".repeat(32));
    assert!(valid.fresh(NOW).is_ok());
    assert!(valid.fresh(NOW - 1).is_err());
    assert!(valid.fresh(NOW + 300).is_err());
    let mut value = valid.clone();
    value.preparation.public_values_sha256 = "99".repeat(32);
    value.preparation = value.preparation.seal();
    value.quote.preparation_id = value.preparation.preparation_id.clone();
    value.quote = value.quote.seal();
    value.settings.quote_id = value.quote.quote_id.clone();
    assert!(value.seal().unwrap().validate().is_err());
    for deadline in [NOW, NOW - 1, NOW + MAX_DEADLINE_SECONDS + 1] {
        let mut value = valid.clone();
        value.settings.deadline_unix = deadline;
        assert!(value.seal().unwrap().validate().is_err());
    }
    let mut value = valid.clone();
    value.settings.prover_whitelist = vec![valid.quote.requester.clone(); 2];
    assert!(value.seal().unwrap().validate().is_err());
    let mut json = serde_json::to_value(valid.settings).unwrap();
    json["verifier"] = "0xother".into();
    assert!(serde_json::from_value::<Settings>(json).is_err());
}

#[test]
fn paid_plan_rejects_relabeling_the_embedded_witness_as_the_reviewed_deployment() {
    use ultratokenizer_network_request_schema::{
        ReviewedSynthetic, REVIEWED_PREPARATION_SCHEMA_VERSION, REVIEWED_SYNTHETIC_KIND,
        REVIEWED_SYNTHETIC_PDF_SHA256, REVIEWED_SYNTHETIC_SIGNER,
    };
    let original = plan(&Signer::fixture().address(), &"bb".repeat(32));
    let mut value = original.clone();
    value.preparation.schema_version = REVIEWED_PREPARATION_SCHEMA_VERSION;
    value.preparation.fixture_kind = REVIEWED_SYNTHETIC_KIND.into();
    value.preparation.pdf_sha256 = REVIEWED_SYNTHETIC_PDF_SHA256.into();
    value.preparation.review_manifest_sha256 = Some("88".repeat(32));
    value.preparation.reviewed_synthetic = Some(ReviewedSynthetic {
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
        request_json_sha256: value.preparation.request_json_sha256.clone(),
        request_digest: value.preparation.request_digest.clone(),
    });
    value.preparation = value.preparation.seal();
    value
        .quote
        .preparation_id
        .clone_from(&value.preparation.preparation_id);
    value.quote = value.quote.seal();
    value.settings.quote_id.clone_from(&value.quote.quote_id);
    assert!(value.seal().unwrap().validate().is_err());
}

#[tokio::test]
async fn exact_signed_protobuf_is_durable_before_one_send_and_restart_cannot_resend() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, mut log) = setup(&directory, &signer);
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .unwrap();
    assert_eq!(network.nonce_calls, 1);
    assert_eq!(network.sends.len(), 1);
    assert_eq!(signer.calls.get(), 1);
    let signed = &network.sends[0];
    let body = signed.body.as_ref().unwrap();
    assert_eq!(
        body.public_values_hash,
        Some(hex::decode(&value.preparation.public_values_sha256).unwrap())
    );
    assert_eq!(body.mode, i32::from(rpc::ProofMode::Groth16));
    assert_eq!(
        body.vk_hash,
        hex::decode(
            ultratokenizer_network_request_schema::EXPECTED_NETWORK_VK_HASH
                .trim_start_matches("0x")
        )
        .unwrap()
    );
    assert_ne!(
        body.vk_hash,
        decode_prefixed(&value.preparation.program_v_key).unwrap()
    );
    assert_eq!(body.version, "sp1-v6.1.0");
    assert!(body.stdin_private);
    drop(log);
    let mut log = Journal::<RequestEvent>::open(&directory.path("request.jsonl")).unwrap();
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    assert_eq!(network.nonce_calls, 1);
    assert_eq!(network.sends.len(), 1);
    assert_eq!(signer.calls.get(), 1);
}

#[tokio::test]
async fn changed_current_quote_or_expiration_prevents_signing_and_send() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, mut log) = setup(&directory, &signer);
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    network.params_changed = true;
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    assert_eq!(network.nonce_calls, 0);
    assert_eq!(signer.calls.get(), 0);
    assert!(network.sends.is_empty());
    network.params_changed = false;
    let count = Cell::new(0);
    assert!(submit_once(&mut log, &mut network, &signer, || {
        let n = count.get();
        count.set(n + 1);
        Ok(if n == 0 { NOW } else { NOW + 300 })
    })
    .await
    .is_err());
    assert_eq!(network.nonce_calls, 1);
    assert_eq!(signer.calls.get(), 0);
    assert!(network.sends.is_empty());
}

struct FaultLog {
    inner: Journal<RequestEvent>,
    fail_phase: u8,
    after_write: bool,
}
impl RequestLog for FaultLog {
    fn events(&self) -> &[Event<RequestEvent>] {
        self.inner.events()
    }
    fn append(&mut self, value: RequestEvent, now: u64) -> Result<(), &'static str> {
        let phase = match &value {
            RequestEvent::SigningIntent { .. } => 1,
            RequestEvent::Signed { .. } => 2,
            RequestEvent::DispatchAttempted { .. } => 3,
            RequestEvent::Acknowledged { .. } => 4,
            _ => 0,
        };
        if phase == self.fail_phase {
            if self.after_write {
                self.inner.append(value, now)?;
            }
            return Err("fixture write or sync failure");
        }
        self.inner.append(value, now)
    }
}

#[tokio::test]
async fn persistence_failure_at_each_pre_send_barrier_prevents_dispatch() {
    for phase in 1..=3 {
        for after_write in [false, true] {
            let directory = Directory::new();
            let signer = Signer::fixture();
            let (value, inner) = setup(&directory, &signer);
            let mut log = FaultLog {
                inner,
                fail_phase: phase,
                after_write,
            };
            let mut network = Network::fixture(&value, directory.path("request.jsonl"));
            assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
                .await
                .is_err());
            assert!(
                network.sends.is_empty(),
                "phase {phase}, after_write {after_write}"
            );
            assert_eq!(signer.calls.get(), u32::from(phase > 1));
        }
    }
}

#[tokio::test]
async fn ambiguous_submission_recovers_exact_nonce_signature_without_new_send_or_release() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, mut log) = setup(&directory, &signer);
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    network.ambiguous = true;
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    assert!(RequestState::read(log.events()).unwrap().dispatched);
    network.index_sent();
    let result = recover_once(&mut log, &mut network, || Ok(NOW + 400))
        .await
        .unwrap();
    assert_eq!(result["budgetReleased"], false);
    assert_eq!(result["proofVerified"], false);
    assert_eq!(result["proofDownloaded"], false);
    assert_eq!(result["fulfiller"], serde_json::Value::Null);
    assert_eq!(result["serviceCreatedAtUnix"], serde_json::Value::Null);
    assert_eq!(result["serviceUpdatedAtUnix"], serde_json::Value::Null);
    assert_eq!(network.nonce_calls, 1);
    assert_eq!(network.sends.len(), 1);
    assert_eq!(signer.calls.get(), 1);
    assert_eq!(network.filters[0].limit, Some(100));
    assert_eq!(
        network.filters[0].requester,
        Some(decode_prefixed(&signer.address()).unwrap())
    );
    assert!(
        submit_once(&mut log, &mut network, &signer, || Ok(NOW + 400))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn assigned_recovery_reports_deadline_without_reclassifying_or_resubmitting() {
    for (offset, passed) in [(-1_i64, false), (0, true), (1, true)] {
        let directory = Directory::new();
        let signer = Signer::fixture();
        let (value, mut log) = setup(&directory, &signer);
        let mut network = Network::fixture(&value, directory.path("request.jsonl"));
        submit_once(&mut log, &mut network, &signer, || Ok(NOW))
            .await
            .unwrap();
        network.index_sent();
        network.status.fulfillment_status = rpc::FulfillmentStatus::Assigned.into();
        network.status.execution_status = rpc::ExecutionStatus::Executed.into();
        network.status.public_values_hash =
            Some(hex::decode(&value.preparation.public_values_sha256).unwrap());
        network.candidates[0].created_at = NOW;
        network.candidates[0].updated_at = NOW + 60;
        network.candidates[0].fulfiller = Some(vec![0x42; 20]);
        let observed = value
            .settings
            .deadline_unix
            .checked_add_signed(offset)
            .unwrap();
        let result = recover_once(&mut log, &mut network, || Ok(observed))
            .await
            .unwrap();
        assert_eq!(result["deadlineUnix"], value.settings.deadline_unix);
        assert_eq!(result["observedAtUnix"], observed);
        assert_eq!(result["deadlinePassed"], passed);
        assert_eq!(result["serviceCreatedAtUnix"], NOW);
        assert_eq!(result["serviceUpdatedAtUnix"], NOW + 60);
        assert_eq!(result["fulfiller"], format!("0x{}", "42".repeat(20)));
        assert_eq!(result["fulfillmentStatus"], 2);
        assert_eq!(result["executionStatus"], 2);
        assert_eq!(result["proofAvailable"], false);
        assert_eq!(result["proofVerified"], false);
        assert_eq!(result["proofDownloaded"], false);
        assert_eq!(result["budgetReleased"], false);
        assert_eq!(result["automaticRetryAllowed"], false);
        assert_eq!(log.events().last().unwrap().at_unix, observed);
        assert_eq!(network.sends.len(), 1);
        assert_eq!(network.nonce_calls, 1);
        assert_eq!(signer.calls.get(), 1);
        assert!(!result.to_string().contains("s3://"));
        assert!(
            submit_once(&mut log, &mut network, &signer, || Ok(observed))
                .await
                .is_err()
        );
        assert_eq!(network.sends.len(), 1);
    }
}

#[tokio::test]
async fn request_fields_alone_cannot_recover_another_nonce_or_signature() {
    for mutation in 0..4 {
        let directory = Directory::new();
        let signer = Signer::fixture();
        let (value, mut log) = setup(&directory, &signer);
        let mut network = Network::fixture(&value, directory.path("request.jsonl"));
        network.ambiguous = true;
        assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
            .await
            .is_err());
        network.index_sent();
        match mutation {
            0 => network.transactions[0].nonce += 1,
            1 => network.transactions[0].signature[0] ^= 1,
            2 => network.candidates[0].gas_limit += 1,
            _ => network.transactions[0].request_id = Some(vec![0x77; 32]),
        }
        assert!(recover_once(&mut log, &mut network, || Ok(NOW + 400))
            .await
            .is_err());
        assert!(RequestState::read(log.events()).unwrap().known.is_none());
        assert_eq!(network.sends.len(), 1);
        assert_eq!(network.nonce_calls, 1);
    }
}

#[tokio::test]
async fn false_acknowledgement_is_only_a_hint_and_exact_recovery_can_correct_it() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, mut log) = setup(&directory, &signer);
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    network.response.body.as_mut().unwrap().request_id = vec![0x99; 32];
    submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .unwrap();
    network.index_sent();
    let result = recover_once(&mut log, &mut network, || Ok(NOW + 1))
        .await
        .unwrap();
    assert_eq!(result["requestId"], format!("0x{}", "72".repeat(32)));
    assert_eq!(network.sends.len(), 1);
}

#[tokio::test]
async fn post_send_sync_failure_preserves_signed_evidence_and_can_be_recovered() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, inner) = setup(&directory, &signer);
    let mut log = FaultLog {
        inner,
        fail_phase: 4,
        after_write: false,
    };
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    network.index_sent();
    drop(log);
    let mut log = Journal::<RequestEvent>::open(&directory.path("request.jsonl")).unwrap();
    recover_once(&mut log, &mut network, || Ok(NOW + 1))
        .await
        .unwrap();
    assert_eq!(network.sends.len(), 1);
}

#[tokio::test]
async fn empty_lookup_is_unresolved_and_wrong_status_never_becomes_verified_proof() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, mut log) = setup(&directory, &signer);
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    network.ambiguous = true;
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    assert!(recover_once(&mut log, &mut network, || Ok(NOW + 1))
        .await
        .is_err());
    network.index_sent();
    network.status.request_tx_hash = vec![0x99; 32];
    assert!(recover_once(&mut log, &mut network, || Ok(NOW + 1))
        .await
        .is_err());
    assert!(RequestState::read(log.events()).unwrap().known.is_some());
    network.status.request_tx_hash = vec![0x71; 32];
    network.status.fulfillment_status = rpc::FulfillmentStatus::Fulfilled.into();
    network.status.execution_status = rpc::ExecutionStatus::Executed.into();
    network.status.proof_uri = Some("https://fixture.invalid/proof".into());
    network.status.fulfill_tx_hash = Some(vec![0x78; 32]);
    assert!(recover_once(&mut log, &mut network, || Ok(NOW + 2))
        .await
        .is_err());
    network.status.public_values_hash =
        Some(hex::decode(&value.preparation.public_values_sha256).unwrap());
    let result = recover_once(&mut log, &mut network, || Ok(NOW + 3))
        .await
        .unwrap();
    assert_eq!(result["proofAvailable"], true);
    assert_eq!(result["proofVerified"], false);
    assert!(!result.to_string().contains("fixture.invalid"));
}

#[tokio::test]
async fn recovery_pages_and_transaction_detail_reads_are_bounded() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let (value, mut log) = setup(&directory, &signer);
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    network.ambiguous = true;
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    network.index_sent();
    network.page_flood = true;
    assert!(recover_once(&mut log, &mut network, || Ok(NOW + 1))
        .await
        .is_err());
    assert_eq!(network.filters.len(), 5);
    assert_eq!(network.transaction_calls, 0);
    network.page_flood = false;
    let candidate = network.candidates[0].clone();
    network.candidates = (1..=9)
        .map(|n| {
            let mut candidate = candidate.clone();
            candidate.request_id[0] = n;
            candidate.tx_hash[0] = n;
            candidate
        })
        .collect();
    assert!(recover_once(&mut log, &mut network, || Ok(NOW + 2))
        .await
        .is_err());
    assert_eq!(network.transaction_calls, 8);
    assert_eq!(network.sends.len(), 1);
    assert!(RequestState::read(log.events()).unwrap().known.is_none());
}

#[tokio::test]
async fn executed_recovery_requires_a_matching_commitment_and_rejects_either_response_conflict() {
    // Real auction RPC can omit status field 7 while details field 23 contains
    // the execution result. This is recoverable without treating an echo from
    // unexecuted details as execution or accepting a contradictory second hash.
    for (status_hash, details_hash, details_executed, accepted) in [
        (None, Some(true), true, true),
        (Some(true), None, true, true),
        (Some(true), Some(true), true, true),
        (None, None, true, false),
        (None, Some(true), false, false),
        (Some(false), Some(true), true, false),
        (Some(true), Some(false), true, false),
        (None, Some(false), true, false),
        (Some(false), None, true, false),
    ] {
        let directory = Directory::new();
        let signer = Signer::fixture();
        let (value, mut log) = setup(&directory, &signer);
        let expected = hex::decode(&value.preparation.public_values_sha256).unwrap();
        let hash = |matching: bool| {
            if matching {
                expected.clone()
            } else {
                vec![0x99; 32]
            }
        };
        let mut network = Network::fixture(&value, directory.path("request.jsonl"));
        submit_once(&mut log, &mut network, &signer, || Ok(NOW))
            .await
            .unwrap();
        network.index_sent();
        network.status.fulfillment_status = rpc::FulfillmentStatus::Assigned.into();
        network.status.execution_status = rpc::ExecutionStatus::Executed.into();
        network.status.public_values_hash = status_hash.map(hash);
        network.candidates[0].execution_status = if details_executed {
            rpc::ExecutionStatus::Executed.into()
        } else {
            rpc::ExecutionStatus::Unexecuted.into()
        };
        network.candidates[0].public_values_hash = details_hash.map(hash);
        let result = recover_once(&mut log, &mut network, || Ok(NOW + 1)).await;
        assert_eq!(result.is_ok(), accepted);
        if let Ok(value) = result {
            assert_eq!(value["proofAvailable"], false);
            assert_eq!(value["proofVerified"], false);
            assert_eq!(value["budgetReleased"], false);
        }
        assert_eq!(network.sends.len(), 1);
        assert_eq!(signer.calls.get(), 1);
        assert_eq!(network.nonce_calls, 1);
        assert!(RequestState::read(log.events()).unwrap().known.is_some());
        assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW + 2))
            .await
            .is_err());
        assert_eq!(network.sends.len(), 1);
    }
}

fn staged_events(plan: &Plan) -> Vec<crate::journal::StageEvent> {
    let kind = crate::disclosure::artifact_kind(plan.public_disclosure.as_ref()).to_owned();
    let body = vec![
        StageEventBody::Intent {
            preparation_id: plan.preparation.preparation_id.clone(),
            requester: plan.quote.requester.clone(),
            elf_sha256: plan.preparation.elf_sha256.clone(),
            witness_sha256: plan.preparation.witness_sha256.clone(),
            proof_request_allowed: false,
            public_disclosure: plan.public_disclosure.clone(),
            network_vk_hash: plan.network_vk_hash.clone(),
        },
        StageEventBody::ProgramObserved {
            registered: true,
            program_uri: Some(plan.program_uri.clone()),
        },
        StageEventBody::ArtifactAllocationAttempted {
            artifact_kind: kind.clone(),
        },
        StageEventBody::ArtifactAllocated {
            artifact_kind: kind.clone(),
            artifact_uri: plan.stdin_uri.clone(),
        },
        StageEventBody::ArtifactUploadAttempted {
            artifact_kind: kind.clone(),
            artifact_uri: plan.stdin_uri.clone(),
            payload_sha256: "ef".repeat(32),
            payload_bytes: 400,
        },
        StageEventBody::ArtifactUploaded {
            artifact_kind: kind,
            artifact_uri: plan.stdin_uri.clone(),
            payload_sha256: "ef".repeat(32),
            payload_bytes: 400,
        },
        StageEventBody::Complete {
            preparation_id: plan.preparation.preparation_id.clone(),
            requester: plan.quote.requester.clone(),
            program_uri: plan.program_uri.clone(),
            stdin_uri: plan.stdin_uri.clone(),
            witness_sha256: plan.preparation.witness_sha256.clone(),
            proof_request_submitted: false,
        },
    ];
    body.into_iter()
        .map(|body| crate::journal::StageEvent {
            schema_version: 1,
            at_unix: plan.quote.observed_at_unix,
            operation_id: crate::network_identity::operation_id(
                &plan.preparation.preparation_id,
                &plan.quote.requester,
                plan.public_disclosure.as_ref(),
                plan.network_vk_hash.as_deref(),
            )
            .unwrap(),
            body,
        })
        .collect()
}

#[test]
fn offline_prepare_binds_exact_quote_and_staging_bytes_before_reserving_budget() {
    offline_prepare_reviewed_stage(false);
    offline_prepare_reviewed_stage(true);
}

fn offline_prepare_reviewed_stage(public: bool) {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let mut value = if public {
        reviewed_public_plan(&signer.address(), &"bb".repeat(32))
    } else {
        plan(&signer.address(), &"bb".repeat(32))
    };
    let now = unix_time().unwrap();
    value.preparation.created_at_unix = now;
    value.preparation = value.preparation.seal();
    if let Some(disclosure) = &mut value.public_disclosure {
        disclosure
            .preparation_id
            .clone_from(&value.preparation.preparation_id);
        disclosure.valid_until_unix = now + 4000;
    }
    value.quote.preparation_id = value.preparation.preparation_id.clone();
    value.quote.observed_at_unix = now;
    value.quote.review_valid_until_unix = now + 300;
    value.quote = value.quote.seal();
    value.settings.quote_id = value.quote.quote_id.clone();
    value.settings.deadline_unix = now + 3600;
    let preparation_path = directory.path("fixture.sp1-network-preparation.json");
    let quote_path = directory.path("fixture.sp1-network-quote.json");
    let stage_path = directory.path("fixture.sp1-network-staging.jsonl");
    let settings_path = directory.path("fixture.sp1-network-submission.json");
    let budget_path = directory.path("fixture.sp1-network-budget.jsonl");
    let request_path = directory.path("fixture.sp1-network-request.jsonl");
    let quote_bytes = serde_json::to_vec(&value.quote).unwrap();
    let stage_bytes = staged_events(&value)
        .iter()
        .map(|event| format!("{}\n", serde_json::to_string(event).unwrap()))
        .collect::<String>()
        .into_bytes();
    value.settings.quote_file_sha256 = sha256_hex(&quote_bytes);
    value.settings.staging_journal_sha256 = sha256_hex(&stage_bytes);
    std::fs::write(
        &preparation_path,
        serde_json::to_vec(&value.preparation).unwrap(),
    )
    .unwrap();
    std::fs::write(&quote_path, &quote_bytes).unwrap();
    std::fs::write(&stage_path, &stage_bytes).unwrap();
    std::fs::write(&settings_path, serde_json::to_vec(&value.settings).unwrap()).unwrap();
    init_budget(&[
        "init-budget".into(),
        signer.address(),
        "500".into(),
        "900".into(),
        budget_path.to_str().unwrap().into(),
    ])
    .unwrap();
    let args = vec![
        "prepare-request".into(),
        preparation_path.to_str().unwrap().into(),
        quote_path.to_str().unwrap().into(),
        stage_path.to_str().unwrap().into(),
        settings_path.to_str().unwrap().into(),
        budget_path.to_str().unwrap().into(),
        request_path.to_str().unwrap().into(),
    ];
    // Semantically identical JSON with a different byte representation is not the reviewed file.
    std::fs::write(&quote_path, [&quote_bytes[..], b"\n"].concat()).unwrap();
    assert!(prepare(&args).is_err());
    assert!(!request_path.exists());
    std::fs::write(&quote_path, quote_bytes).unwrap();
    std::fs::write(&stage_path, [&stage_bytes[..], b"\n"].concat()).unwrap();
    assert!(prepare(&args).is_err());
    assert!(!request_path.exists());
    std::fs::write(&stage_path, stage_bytes).unwrap();
    prepare(&args).unwrap();
    let budget_log = Journal::<BudgetEvent>::open(&budget_path).unwrap();
    let request_log = Journal::<RequestEvent>::open(&request_path).unwrap();
    let state = RequestState::read(request_log.events()).unwrap();
    assert_eq!(state.plan.public_disclosure.is_some(), public);
    assert_eq!(state.plan.body(7).unwrap().stdin_private, !public);
    Budget::read(budget_log.events())
        .unwrap()
        .require_reservation(&state.plan, budget_log.events())
        .unwrap();
    assert!(state.nonce.is_none());
    assert!(state.signed.is_none());
    drop(budget_log);
    drop(request_log);
    assert!(prepare(&args).is_err());
}

fn reviewed_public_plan(requester: &str, budget_id: &str) -> Plan {
    use ultratokenizer_network_request_schema::*;
    let mut value = plan(requester, budget_id);
    let review = ReviewedSynthetic {
        schema_version: 2,
        purpose: "authorized-synthetic-demo-job-proof".into(),
        source_kind: "synthetic-signed-pdf-capsule".into(),
        synthetic: true,
        production_approved: false,
        chain_id: "296".into(),
        gate: DEMO_JOB_GATE.into(),
        token: DEMO_JOB_TOKEN.into(),
        recipient: format!("0x{}", "33".repeat(20)),
        issuer_id: format!("0x{}", "44".repeat(32)),
        source_id: format!("0x{}", "55".repeat(32)),
        amount_milligrams: "1000".into(),
        signer_fingerprint: DEMO_JOB_SIGNER.into(),
        pdf_sha256: DEMO_JOB_PDFS[0].into(),
        request_json_sha256: "66".repeat(32),
        request_digest: value.preparation.request_digest.clone(),
    };
    let mut words = hex::decode(&value.preparation.public_values[2..]).unwrap();
    words[64..96].copy_from_slice(&hex::decode(DEMO_JOB_SIGNER).unwrap());
    value.preparation.schema_version = REVIEWED_PREPARATION_SCHEMA_VERSION;
    value.preparation.fixture_kind = REVIEWED_SYNTHETIC_KIND.into();
    value.preparation.pdf_sha256.clone_from(&review.pdf_sha256);
    value
        .preparation
        .request_json_sha256
        .clone_from(&review.request_json_sha256);
    value.preparation.public_values = format!("0x{}", hex::encode(&words));
    value.preparation.public_values_sha256 = sha256_hex(&words);
    value.preparation.review_manifest_sha256 =
        Some(sha256_hex(&serde_json::to_vec(&review).unwrap()));
    value.preparation.reviewed_synthetic = Some(review);
    value.preparation = value.preparation.seal();
    value
        .quote
        .preparation_id
        .clone_from(&value.preparation.preparation_id);
    value.quote = value.quote.seal();
    value.settings.quote_id.clone_from(&value.quote.quote_id);
    value.stdin_uri = "s3://fixture/stdins/1".into();
    value.public_disclosure = Some(crate::disclosure::PublicDisclosure {
        schema_version: 1,
        purpose: "public-synthetic-sp1-control".into(),
        authorized_public_disclosure: true,
        preparation_id: value.preparation.preparation_id.clone(),
        requester: requester.into(),
        review_manifest_sha256: value.preparation.review_manifest_sha256.clone().unwrap(),
        valid_until_unix: NOW + 4000,
    });
    let value = value.seal().unwrap();
    value.validate().unwrap();
    value
}

#[test]
fn public_visibility_is_bound_to_synthetic_review_and_legacy_identity_is_preserved() {
    let signer = Signer::fixture();
    let legacy = plan(&signer.address(), &"bb".repeat(32));
    let bytes = serde_json::to_vec(&legacy).unwrap();
    assert!(!String::from_utf8(bytes.clone())
        .unwrap()
        .contains("publicDisclosure"));
    let restored: Plan = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(restored.seal().unwrap().plan_id, legacy.plan_id);
    assert!(legacy.body(7).unwrap().stdin_private);
    let public = reviewed_public_plan(&signer.address(), &"bb".repeat(32));
    assert!(!public.body(7).unwrap().stdin_private);
    let mut private = public.clone();
    private.public_disclosure = None;
    private.stdin_uri = "s3://fixture/private-stdins/1".into();
    let private = private.seal().unwrap();
    private.validate().unwrap();
    assert!(private.body(7).unwrap().stdin_private);
    assert_eq!(public.request_identity, private.request_identity);
    assert_ne!(public.plan_id, private.plan_id);
    for (mut value, uri) in [
        (public.clone(), "s3://fixture/private-stdins/1"),
        (private, "s3://fixture/stdins/1"),
        (public.clone(), "s3://stdins/other/1"),
        (public.clone(), "s3://fixture/private-stdins/stdins/1"),
    ] {
        value.stdin_uri = uri.into();
        assert!(value.seal().unwrap().validate().is_err());
    }
    for index in 0..6 {
        let mut changed = public.clone();
        let disclosure = changed.public_disclosure.as_mut().unwrap();
        match index {
            0 => disclosure.authorized_public_disclosure = false,
            1 => disclosure.preparation_id = "other".into(),
            2 => disclosure.requester = format!("0x{}", "99".repeat(20)),
            3 => disclosure.review_manifest_sha256 = "99".repeat(32),
            4 => disclosure.purpose = "private-source-document".into(),
            _ => disclosure.schema_version = 2,
        }
        assert!(changed.seal().unwrap().validate().is_err());
    }
    assert!(public
        .public_disclosure
        .as_ref()
        .unwrap()
        .fresh(NOW + 4000)
        .is_err());
    let mut embedded = legacy;
    embedded.public_disclosure = public.public_disclosure.clone();
    embedded.stdin_uri = public.stdin_uri;
    assert!(embedded.seal().unwrap().validate().is_err());
}

#[test]
fn public_staging_rejects_visibility_substitution_and_cannot_bypass_reserved_witness() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let mut budget_log = budget(&directory, &signer.address(), "500", "2000");
    let budget_id = Budget::read(budget_log.events()).unwrap().id;
    let public = reviewed_public_plan(&signer.address(), &budget_id);
    let encode = |events: &[crate::journal::StageEvent]| {
        events
            .iter()
            .map(|event| format!("{}\n", serde_json::to_string(event).unwrap()))
            .collect::<String>()
    };
    let events = staged_events(&public);
    assert!(crate::journal::parse(encode(&events).as_bytes()).is_ok());
    let mut changed = events.clone();
    if let StageEventBody::Intent {
        public_disclosure, ..
    } = &mut changed[0].body
    {
        *public_disclosure = None;
    }
    assert!(crate::journal::parse(encode(&changed).as_bytes()).is_err());
    let mut changed = events;
    if let StageEventBody::ArtifactAllocationAttempted { artifact_kind } = &mut changed[2].body {
        *artifact_kind = "synthetic_private_stdin".into();
    }
    assert!(crate::journal::parse(encode(&changed).as_bytes()).is_err());
    let mut private = public.clone();
    private.public_disclosure = None;
    private.stdin_uri = "s3://fixture/private-stdins/1".into();
    let private = private.seal().unwrap();
    reserve(&mut budget_log, &private);
    assert!(Budget::read(budget_log.events())
        .unwrap()
        .can_reserve(&public)
        .is_err());
    assert_eq!(budget_log.events().len(), 2);
}

#[tokio::test]
async fn public_paid_request_sends_once_and_unsigned_recovery_binds_visibility() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let value = reviewed_public_plan(&signer.address(), &"bb".repeat(32));
    let mut log = Journal::create(
        &directory.path("request.jsonl"),
        RequestEvent::Prepared {
            plan: Box::new(value.clone()),
        },
        NOW,
    )
    .unwrap();
    let mut network = Network::fixture(&value, directory.path("request.jsonl"));
    submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .unwrap();
    assert!(!network.sends[0].body.as_ref().unwrap().stdin_private);
    network.index_sent();
    recover_once(&mut log, &mut network, || Ok(NOW + 1))
        .await
        .unwrap();
    network.candidates[0].stdin_private = true;
    assert!(recover_once(&mut log, &mut network, || Ok(NOW + 2))
        .await
        .is_err());
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW + 2))
        .await
        .is_err());
    assert_eq!(network.sends.len(), 1);
    assert_eq!(network.nonce_calls, 1);
    assert_eq!(signer.calls.get(), 1);
}

fn legacy_network_plan(requester: &str, budget_id: &str) -> Plan {
    let mut legacy = plan(requester, budget_id);
    legacy.network_vk_hash = None;
    legacy.quote.network_vk_hash = None;
    legacy.quote = legacy.quote.seal();
    legacy.settings.quote_id.clone_from(&legacy.quote.quote_id);
    legacy.seal().unwrap()
}

#[test]
fn network_identity_is_bound_across_quote_plan_stage_and_does_not_reset_budget_identity() {
    let signer = Signer::fixture();
    let current = plan(&signer.address(), &"bb".repeat(32));
    let legacy = legacy_network_plan(&signer.address(), &"bb".repeat(32));
    legacy.validate().unwrap();
    assert_eq!(current.request_identity, legacy.request_identity);
    assert_ne!(current.plan_id, legacy.plan_id);
    assert_ne!(current.quote.quote_id, legacy.quote.quote_id);
    let encoded = serde_json::to_vec(&legacy).unwrap();
    assert!(!String::from_utf8(encoded.clone())
        .unwrap()
        .contains("networkVkHash"));
    let restored: Plan = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(restored.clone().seal().unwrap().plan_id, legacy.plan_id);
    assert_eq!(
        restored.body(7).unwrap().vk_hash,
        decode_prefixed(EXPECTED_PROGRAM_VKEY).unwrap()
    );
    for variant in 0..3 {
        let mut changed = current.clone();
        match variant {
            0 => changed.network_vk_hash = None,
            1 => changed.quote.network_vk_hash = None,
            _ => {
                changed.network_vk_hash = Some(EXPECTED_PROGRAM_VKEY.into());
                changed.quote.network_vk_hash = Some(EXPECTED_PROGRAM_VKEY.into());
            }
        }
        changed.quote = changed.quote.seal();
        changed
            .settings
            .quote_id
            .clone_from(&changed.quote.quote_id);
        assert!(changed.seal().unwrap().validate().is_err());
    }
    let events = staged_events(&current);
    let old_events = staged_events(&legacy);
    assert_ne!(events[0].operation_id, old_events[0].operation_id);
    let mut changed = events;
    if let StageEventBody::Intent {
        network_vk_hash, ..
    } = &mut changed[0].body
    {
        *network_vk_hash = Some(EXPECTED_PROGRAM_VKEY.into());
    }
    let bytes = changed
        .iter()
        .map(|event| format!("{}\n", serde_json::to_string(event).unwrap()))
        .collect::<String>();
    assert!(crate::journal::parse(bytes.as_bytes()).is_err());
    let directory = Directory::new();
    let mut budget_log = budget(&directory, &signer.address(), "500", "2000");
    let id = Budget::read(budget_log.events()).unwrap().id;
    reserve(
        &mut budget_log,
        &legacy_network_plan(&signer.address(), &id),
    );
    assert!(Budget::read(budget_log.events())
        .unwrap()
        .can_reserve(&plan(&signer.address(), &id))
        .is_err());
}

#[tokio::test]
async fn legacy_signed_network_request_remains_recoverable_but_new_legacy_signing_is_forbidden() {
    let directory = Directory::new();
    let signer = Signer::fixture();
    let value = legacy_network_plan(&signer.address(), &"bb".repeat(32));
    let path = directory.path("legacy.jsonl");
    let mut log = Journal::create(
        &path,
        RequestEvent::Prepared {
            plan: Box::new(value.clone()),
        },
        NOW,
    )
    .unwrap();
    let mut network = Network::fixture(&value, path.clone());
    assert!(submit_once(&mut log, &mut network, &signer, || Ok(NOW))
        .await
        .is_err());
    assert_eq!(signer.calls.get(), 0);
    assert_eq!(network.nonce_calls, 0);
    assert!(network.sends.is_empty());
    assert_eq!(log.events().len(), 1);
    // Recreate an already-signed historical fixture without invoking the submit path.
    let body = value.body(7).unwrap();
    let body_bytes = body.encode_to_vec();
    let signed = rpc::RequestProofRequest {
        format: rpc::MessageFormat::Binary.into(),
        signature: signer.sign(&body_bytes).await.unwrap(),
        body: Some(body),
    };
    let bytes = signed.encode_to_vec();
    log.append(
        RequestEvent::SigningIntent {
            nonce: 7,
            body_hex: hex::encode(&body_bytes),
            body_sha256: sha256_hex(&body_bytes),
        },
        NOW,
    )
    .unwrap();
    log.append(
        RequestEvent::Signed {
            request_hex: hex::encode(&bytes),
            request_sha256: sha256_hex(&bytes),
        },
        NOW,
    )
    .unwrap();
    log.append(
        RequestEvent::DispatchAttempted {
            request_sha256: sha256_hex(&bytes),
        },
        NOW,
    )
    .unwrap();
    network.sends.push(signed);
    network.index_sent();
    drop(log);
    let mut reopened = Journal::<RequestEvent>::open(&path).unwrap();
    RequestState::read(reopened.events()).unwrap();
    let recovered = recover_once(&mut reopened, &mut network, || Ok(NOW + 1))
        .await
        .unwrap();
    assert_eq!(recovered["status"], "exact_signed_request_observed");
    assert_eq!(
        network.filters[0].vk_hash,
        Some(decode_prefixed(EXPECTED_PROGRAM_VKEY).unwrap())
    );
    assert_eq!(network.sends.len(), 1);
    assert_eq!(signer.calls.get(), 1);
    assert_eq!(network.nonce_calls, 0);
}

/// Operator-only compatibility check against copied, private archival records. Never pass live
/// journals: opening a journal takes its writer lock even though this test never appends.
#[test]
#[ignore = "requires explicitly supplied copies of private archived journals"]
fn archived_legacy_snapshot_preserves_hashes_signed_bytes_and_budget() {
    let directory = PathBuf::from(std::env::var_os("UT_SP1_LEGACY_SNAPSHOT_DIR").unwrap());
    let request_path = directory.join("request.jsonl");
    let budget_path = directory.join("budget.jsonl");
    let stage_path = directory.join("stage.jsonl");
    let quote_path = directory.join("quote.json");
    let before = [&request_path, &budget_path, &stage_path, &quote_path]
        .map(|path| std::fs::read(path).unwrap());
    let log = Journal::<RequestEvent>::open(&request_path).unwrap();
    let budget_log = Journal::<BudgetEvent>::open(&budget_path).unwrap();
    let state = RequestState::read(log.events()).unwrap();
    assert!(state.plan.network_vk_hash.is_none());
    assert!(state.plan.quote.network_vk_hash.is_none());
    assert!(state.dispatched && state.signed.is_some());
    assert!(
        crate::network_identity::require_current(state.plan.network_vk_hash.as_deref()).is_err()
    );
    let body = state.plan.body(state.nonce.unwrap()).unwrap();
    assert!(body.vk_hash == decode_prefixed(EXPECTED_PROGRAM_VKEY).unwrap());
    assert!(state.signed.as_ref().unwrap().body.as_ref() == Some(&body));
    Budget::read(budget_log.events())
        .unwrap()
        .require_reservation(&state.plan, budget_log.events())
        .unwrap();
    let quote: Quote = serde_json::from_slice(&before[3]).unwrap();
    quote.validate(&state.plan.preparation).unwrap();
    assert!(quote.quote_id == state.plan.quote.quote_id);
    let stage = crate::journal::read(&stage_path).unwrap();
    assert!(matches!(
        &stage[0].body,
        StageEventBody::Intent {
            network_vk_hash: None,
            ..
        }
    ));
    // Exact re-serialization proves optional fields preserve archived event hashes and bytes.
    for (event, line) in log
        .events()
        .iter()
        .zip(std::str::from_utf8(&before[0]).unwrap().lines())
    {
        assert!(serde_json::to_string(event).unwrap() == line);
    }
    for (event, line) in stage
        .iter()
        .zip(std::str::from_utf8(&before[2]).unwrap().lines())
    {
        assert!(serde_json::to_string(event).unwrap() == line);
    }
    drop(log);
    drop(budget_log);
    let after = [&request_path, &budget_path, &stage_path, &quote_path]
        .map(|path| std::fs::read(path).unwrap());
    assert!(before == after);
}
