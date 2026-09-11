//! Bounded retrieval of an exactly recovered artifact. Structural checks never assert proof validity.

use crate::{
    paid_journal::{Event, Journal},
    paid_rpc::PaidRpc,
    paid_state::{
        decode_prefixed, lower_hash, prefixed_word, RequestEvent, RequestState, REQUEST_SUFFIX,
    },
};
use alloy_primitives::U256;
use bincode::Options;
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sp1_sdk::{
    network::proto::auction::types as rpc, ProofFromNetwork, SP1Proof, SP1ProofWithPublicValues,
};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::Duration,
};
use ultratokenizer_network_request_schema::{
    require_suffix, EXPECTED_OUTER_CIRCUIT_VERSION, EXPECTED_PROGRAM_VKEY,
};

pub const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024;
pub const RETRIEVAL_TIMEOUT_SECONDS: u64 = 120;
const MAX_BODY_CHUNKS: usize = 4096;
pub const GROTH16_VERIFIER_HASH: &str =
    "4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696";
const VK_ROOT: &str = "002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352";
const PROOF_SUFFIX: &str = ".sp1-network-proof";
const RECEIPT_SUFFIX: &str = ".sp1-network-submission.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginAdmission {
    pub format: String,
    pub origin: String,
    pub evidence_sha256: String,
    pub maximum_bytes: u64,
}

impl OriginAdmission {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.format != "ultratokenizer.reviewed-artifact-origin.v1"
            || self.maximum_bytes == 0
            || self.maximum_bytes > MAX_ARTIFACT_BYTES
        {
            return Err("Artifact origin admission or byte ceiling is invalid.");
        }
        lower_hash(&self.evidence_sha256)?;
        let parsed = checked_https(&self.origin)?;
        if parsed.origin().ascii_serialization() != self.origin
            || parsed.path() != "/"
            || parsed.query().is_some()
        {
            return Err("Artifact admission must contain one exact canonical HTTPS origin.");
        }
        Ok(())
    }

    fn admit(&self, value: &str) -> Result<Url, &'static str> {
        self.validate()?;
        let url = checked_https(value)?;
        if url.origin().ascii_serialization() != self.origin {
            return Err("Proof URI does not use the independently reviewed artifact origin; no download is allowed.");
        }
        Ok(url)
    }
}

fn checked_https(value: &str) -> Result<Url, &'static str> {
    if value.len() > 2048
        || value
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err("Artifact URL is outside its serialization bounds.");
    }
    let url = Url::parse(value).map_err(|_| "Invalid artifact URL.")?;
    let host = url.host_str().ok_or("Artifact URL has no host.")?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.starts_with('[')
        || host == "localhost"
        || host.ends_with(".localhost")
        || !host.contains('.')
        || host.ends_with('.')
    {
        return Err("Artifact URL must use a reviewed HTTPS DNS origin without credentials or alternate ports.");
    }
    Ok(url)
}

pub trait ArtifactResponse {
    fn status(&self) -> u16;
    fn url(&self) -> &str;
    fn length(&self) -> Option<u64>;
    fn encoding(&self) -> Result<Option<&str>, &'static str>;
    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, &'static str>;
}

pub trait ArtifactTransport {
    type Response: ArtifactResponse;
    async fn get_once(&mut self, url: &Url) -> Result<Self::Response, &'static str>;
}

pub struct HttpsArtifacts {
    client: reqwest::Client,
}
impl HttpsArtifacts {
    pub fn new() -> Result<Self, &'static str> {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .retry(reqwest::retry::never())
            .https_only(true)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "Unable to construct bounded artifact transport.")?;
        Ok(Self { client })
    }
}
impl ArtifactTransport for HttpsArtifacts {
    type Response = reqwest::Response;
    async fn get_once(&mut self, url: &Url) -> Result<Self::Response, &'static str> {
        self.client
            .get(url.clone())
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| "Artifact GET failed; the request budget remains encumbered.")
    }
}
impl ArtifactResponse for reqwest::Response {
    fn status(&self) -> u16 {
        self.status().as_u16()
    }
    fn url(&self) -> &str {
        self.url().as_str()
    }
    fn length(&self) -> Option<u64> {
        self.content_length()
    }
    fn encoding(&self) -> Result<Option<&str>, &'static str> {
        if self
            .headers()
            .get_all(reqwest::header::CONTENT_ENCODING)
            .iter()
            .count()
            > 1
        {
            return Err("Artifact has more than one content encoding header.");
        }
        self.headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .map(|v| {
                v.to_str()
                    .map_err(|_| "Artifact content encoding is malformed.")
            })
            .transpose()
    }
    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, &'static str> {
        self.chunk()
            .await
            .map(|v| v.map(|v| v.to_vec()))
            .map_err(|_| "Artifact body read failed; partial data is not accepted.")
    }
}

pub struct OutputPaths<'a> {
    pub raw: &'a Path,
    pub normalized: &'a Path,
    pub receipt: &'a Path,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalReceipt {
    pub format: &'static str,
    pub status: &'static str,
    pub request_id: String,
    pub request_transaction_hash: String,
    pub fulfillment_transaction_hash: String,
    pub request_journal_sha256: String,
    pub origin_admission_sha256: String,
    pub origin_evidence_sha256: String,
    pub proof_uri_sha256: String,
    pub artifact_sha256: String,
    pub artifact_bytes: usize,
    pub normalized_sha256: String,
    pub normalized_bytes: usize,
    pub wire_format: &'static str,
    pub program_v_key: String,
    pub outer_circuit_version: String,
    pub public_values_sha256: String,
    pub observed_at_unix: u64,
    pub proof_cryptographically_verified: bool,
    pub independent_inclusion_verified: bool,
    pub budget_released: bool,
}

pub async fn retrieve_once<R: PaidRpc, T: ArtifactTransport>(
    journal_path: &Path,
    expected_journal_sha256: &str,
    admission: &OriginAdmission,
    outputs: OutputPaths<'_>,
    network: &mut R,
    transport: &mut T,
) -> Result<RetrievalReceipt, &'static str> {
    retrieve_with_timeout(
        journal_path,
        expected_journal_sha256,
        admission,
        outputs,
        network,
        transport,
        Duration::from_secs(RETRIEVAL_TIMEOUT_SECONDS),
    )
    .await
}

async fn retrieve_with_timeout<R: PaidRpc, T: ArtifactTransport>(
    journal_path: &Path,
    expected_journal_sha256: &str,
    admission: &OriginAdmission,
    outputs: OutputPaths<'_>,
    network: &mut R,
    transport: &mut T,
    timeout: Duration,
) -> Result<RetrievalReceipt, &'static str> {
    tokio::time::timeout(timeout,
        retrieve_inner(journal_path, expected_journal_sha256, admission, outputs, network, transport))
        .await.map_err(|_| "Artifact retrieval deadline elapsed; retain any partial outputs and do not resubmit the paid request.")?
}

async fn retrieve_inner<R: PaidRpc, T: ArtifactTransport>(
    journal_path: &Path,
    expected_journal_sha256: &str,
    admission: &OriginAdmission,
    outputs: OutputPaths<'_>,
    network: &mut R,
    transport: &mut T,
) -> Result<RetrievalReceipt, &'static str> {
    require_suffix(
        journal_path
            .to_str()
            .ok_or("Invalid request journal path.")?,
        REQUEST_SUFFIX,
    )?;
    lower_hash(expected_journal_sha256)?;
    for (path, suffix) in [
        (outputs.raw, PROOF_SUFFIX),
        (outputs.normalized, PROOF_SUFFIX),
        (outputs.receipt, RECEIPT_SUFFIX),
    ] {
        require_suffix(
            path.to_str().ok_or("Invalid artifact output path.")?,
            suffix,
        )?;
        if path.exists() {
            return Err("Artifact output already exists; it will not be overwritten.");
        }
    }
    if outputs.raw == outputs.normalized {
        return Err("Raw and normalized artifact outputs must be distinct.");
    }
    // Hold the existing journal lock for the entire read/download/save operation.
    // The expected full-file hash is reviewed independently, not received from the network.
    let journal = Journal::<RequestEvent>::open(journal_path)?;
    let journal_bytes = read_limit(journal_path, 2 * 1024 * 1024)?;
    if sha256(&journal_bytes) != expected_journal_sha256 {
        return Err("Paid request journal differs from its exact reviewed hash.");
    }
    check_snapshot(&journal_bytes, journal.events())?;
    let started_at_unix = crate::unix_time()?;
    if journal
        .events()
        .last()
        .is_some_and(|event| event.at_unix > started_at_unix)
    {
        return Err("Request journal observation is ahead of the local clock.");
    }
    let state = RequestState::read(journal.events())?;
    let (request_id, transaction_hash) = state
        .known
        .as_ref()
        .ok_or("An exact recovered request is required before retrieval.")?;
    let RequestEvent::Observed {
        request_id: observed_id,
        transaction_hash: observed_tx,
        fulfillment_status,
        execution_status,
        proof_uri: Some(proof_uri),
        proof_uri_sha256: Some(uri_hash),
    } = &journal
        .events()
        .last()
        .ok_or("Missing fulfilled observation.")?
        .body
    else {
        return Err("The latest durable observation does not identify a proof artifact.");
    };
    if observed_id != request_id
        || observed_tx != transaction_hash
        || *fulfillment_status != i32::from(rpc::FulfillmentStatus::Fulfilled)
        || *execution_status != i32::from(rpc::ExecutionStatus::Executed)
        || sha256(proof_uri.as_bytes()) != *uri_hash
    {
        return Err("The durable request observation is not exactly fulfilled and executed.");
    }
    let url = admission.admit(proof_uri)?;
    let signed = state
        .signed
        .as_ref()
        .ok_or("Missing durable signed request.")?;
    let body = signed.body.as_ref().ok_or("Missing signed request body.")?;
    let id_bytes = decode_prefixed(request_id)?;
    let tx_bytes = decode_prefixed(transaction_hash)?;
    let candidate = network
        .request(id_bytes.clone())
        .await?
        .ok_or("Fulfilled request details are unavailable.")?;
    if candidate.request_id != id_bytes
        || candidate.tx_hash != tx_bytes
        || candidate.requester != decode_prefixed(&state.plan.quote.requester)?
        || candidate.vk_hash != body.vk_hash
        || candidate.version != body.version
        || candidate.mode != body.mode
        || candidate.strategy != body.strategy
        || candidate.program_uri != state.plan.program_uri
        || candidate.stdin_uri != body.stdin_uri
        || candidate.deadline != body.deadline
        || candidate.cycle_limit != body.cycle_limit
        || candidate.gas_limit != body.gas_limit
        || candidate.min_auction_period != body.min_auction_period
        || candidate.whitelist != body.whitelist
        || candidate.base_fee.as_ref() != Some(&body.base_fee)
        || candidate.max_price_per_pgu.as_ref() != Some(&body.max_price_per_pgu)
        || candidate.stdin_private != body.stdin_private
    {
        return Err("Current request details differ from the exact recovered signed intent.");
    }
    let transaction = network
        .transaction(tx_bytes.clone())
        .await?
        .ok_or("Fulfilled transaction details are unavailable.")?;
    if transaction.tx_hash != tx_bytes
        || transaction.request_id.as_ref() != Some(&id_bytes)
        || transaction.sender != decode_prefixed(&state.plan.quote.requester)?
        || transaction.nonce != body.nonce
        || transaction.signature != signed.signature
    {
        return Err(
            "Current request transaction differs from the recorded nonce, signer or signature.",
        );
    }
    let status = network.status(id_bytes).await?;
    if status.fulfillment_status != *fulfillment_status
        || status.execution_status != *execution_status
        || status.request_tx_hash != tx_bytes
        || status.deadline != body.deadline
        || status.proof_uri.as_deref() != Some(proof_uri)
    {
        return Err("Current fulfilled status or artifact URI changed; obtain a new exact recovery observation first.");
    }
    crate::paid::validate_execution_commitment(body, &candidate, &status)?;
    let fulfillment_hash = format!(
        "0x{}",
        hex::encode(
            status
                .fulfill_tx_hash
                .ok_or("Fulfillment transaction identity is missing.")?
        )
    );
    prefixed_word(&fulfillment_hash)?;
    let observed_at_unix = crate::unix_time()?;
    let raw = download_once(transport, &url, admission.maximum_bytes).await?;
    let (normalized, wire_format) = normalize(
        &raw,
        &state.plan.preparation.public_values,
        &state.plan.preparation.public_values_sha256,
        &state.plan.preparation.program_v_key,
    )?;
    let receipt = RetrievalReceipt {
        format: "ultratokenizer.retrieved-proof.v1",
        status: "downloaded_unverified",
        request_id: request_id.clone(),
        request_transaction_hash: transaction_hash.clone(),
        fulfillment_transaction_hash: fulfillment_hash,
        request_journal_sha256: expected_journal_sha256.into(),
        origin_admission_sha256: sha256(
            &serde_json::to_vec(admission).map_err(|_| "Unable to encode origin admission.")?,
        ),
        origin_evidence_sha256: admission.evidence_sha256.clone(),
        proof_uri_sha256: uri_hash.clone(),
        artifact_sha256: sha256(&raw),
        artifact_bytes: raw.len(),
        normalized_sha256: sha256(&normalized),
        normalized_bytes: normalized.len(),
        wire_format,
        program_v_key: state.plan.preparation.program_v_key.clone(),
        outer_circuit_version: state.plan.preparation.outer_circuit_version.clone(),
        public_values_sha256: state.plan.preparation.public_values_sha256.clone(),
        observed_at_unix,
        proof_cryptographically_verified: false,
        independent_inclusion_verified: false,
        budget_released: false,
    };
    // None of these files is a verification success marker. A partial save fails and
    // leaves the already-created files intact for review; no output is overwritten.
    write_new(outputs.raw, &raw)?;
    write_new(outputs.normalized, &normalized)?;
    write_new(
        outputs.receipt,
        &serde_json::to_vec_pretty(&receipt).map_err(|_| "Unable to encode retrieval receipt.")?,
    )?;
    Ok(receipt)
}

async fn download_once<T: ArtifactTransport>(
    transport: &mut T,
    url: &Url,
    maximum: u64,
) -> Result<Vec<u8>, &'static str> {
    if maximum == 0 || maximum > MAX_ARTIFACT_BYTES {
        return Err("Invalid artifact byte ceiling.");
    }
    let mut response = transport.get_once(url).await?;
    if response.status() != 200
        || response.url() != url.as_str()
        || response
            .encoding()?
            .is_some_and(|value| value != "identity")
    {
        return Err(
            "Artifact response must be a direct HTTP 200 without redirects or content encoding.",
        );
    }
    let length = response.length();
    if length.is_some_and(|n| n == 0 || n > maximum) {
        return Err("Artifact Content-Length exceeds its admitted bound.");
    }
    let mut bytes = Vec::new();
    let mut chunks = 0;
    while let Some(chunk) = response.chunk().await? {
        chunks += 1;
        if chunks > MAX_BODY_CHUNKS || chunk.is_empty() {
            return Err("Artifact body has too many or empty chunks.");
        }
        if bytes.len().saturating_add(chunk.len()) > maximum as usize {
            return Err("Artifact streaming byte ceiling exceeded.");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() || length.is_some_and(|n| n != bytes.len() as u64) {
        return Err("Artifact body is empty or does not match Content-Length.");
    }
    Ok(bytes)
}

fn codec() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_ARTIFACT_BYTES)
        .reject_trailing_bytes()
}

fn normalize(
    raw: &[u8],
    expected_values: &str,
    expected_hash: &str,
    expected_vkey: &str,
) -> Result<(Vec<u8>, &'static str), &'static str> {
    // Fixed-int bincode encodes the SP1Proof enum discriminant first. Reject other
    // proof families before asking serde to allocate their potentially large types.
    if raw.len() > MAX_ARTIFACT_BYTES as usize || raw.get(..4) != Some(&3_u32.to_le_bytes()) {
        return Err("Artifact must contain a bounded canonical Groth16 proof envelope.");
    }
    let (proof, format) = if let Ok(proof) = codec().deserialize::<ProofFromNetwork>(raw) {
        if codec()
            .serialize(&proof)
            .map_err(|_| "Invalid network proof encoding.")?
            != raw
        {
            return Err("Network proof encoding is not canonical.");
        }
        (
            SP1ProofWithPublicValues::from(proof),
            "sp1-proof-from-network",
        )
    } else {
        let proof = codec()
            .deserialize::<SP1ProofWithPublicValues>(raw)
            .map_err(|_| "Artifact is not an exact supported proof serialization.")?;
        if codec()
            .serialize(&proof)
            .map_err(|_| "Invalid proof encoding.")?
            != raw
        {
            return Err("Proof encoding is not canonical.");
        }
        (proof, "sp1-proof-with-public-values")
    };
    if expected_vkey != EXPECTED_PROGRAM_VKEY
        || proof.sp1_version != EXPECTED_OUTER_CIRCUIT_VERSION
        || proof.tee_proof.is_some()
        || proof.public_values.as_slice() != decode_prefixed(expected_values)?
        || sha256(proof.public_values.as_slice()) != expected_hash
    {
        return Err("Artifact version, TEE mode, VKey admission or exact public values differ from the reviewed request.");
    }
    let SP1Proof::Groth16(wrapped) = &proof.proof else {
        return Err("Artifact is not Groth16.");
    };
    let encoded =
        hex::decode(&wrapped.encoded_proof).map_err(|_| "Groth16 encoding is not hexadecimal.")?;
    let root = hex::decode(VK_ROOT).map_err(|_| "Pinned recursion root is invalid.")?;
    if encoded.len() != 352
        || wrapped.encoded_proof != hex::encode(&encoded)
        || hex::encode(wrapped.groth16_vkey_hash) != GROTH16_VERIFIER_HASH
        || encoded[..32] != [0_u8; 32]
        || encoded[32..64] != root
    {
        return Err(
            "Groth16 envelope, exit code or outer verifier identity does not match v6.1.0.",
        );
    }
    let mut public_hash = Sha256::digest(proof.public_values.as_slice()).to_vec();
    public_hash[0] &= 0x1f;
    let public_inputs = [
        U256::from_be_slice(&decode_prefixed(expected_vkey)?).to_string(),
        U256::from_be_slice(&public_hash).to_string(),
        "0".into(),
        U256::from_be_slice(&root).to_string(),
        U256::from_be_slice(&encoded[64..96]).to_string(),
    ];
    if wrapped.public_inputs != public_inputs {
        return Err("Groth16 public input metadata does not bind the reviewed VKey and values.");
    }
    // No pairing verification occurs here. The normalized output is solely an input
    // to the existing independent claim-runner verify-local/export-groth16 command.
    Ok((
        codec()
            .serialize(&proof)
            .map_err(|_| "Normalized proof exceeds its bound.")?,
        format,
    ))
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn check_snapshot(bytes: &[u8], locked_events: &[Event<RequestEvent>]) -> Result<(), &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Reviewed journal bytes are not UTF-8.")?;
    let events: Vec<Event<RequestEvent>> = text
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|_| "Reviewed journal event is invalid."))
        .collect::<Result<_, _>>()?;
    if serde_json::to_vec(&events).map_err(|_| "Unable to encode reviewed journal events.")?
        != serde_json::to_vec(locked_events)
            .map_err(|_| "Unable to encode locked journal events.")?
    {
        return Err("Reviewed journal bytes differ from the locked request snapshot.");
    }
    Ok(())
}
fn read_limit(path: &Path, maximum: u64) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Unable to read selected request journal.")?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read selected request journal.")?;
    if bytes.len() as u64 > maximum {
        return Err("Selected request journal is oversized.");
    }
    Ok(bytes)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Artifact output already exists or cannot be created.")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "Artifact output write failed; retain existing partial files for review.")?;
    File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|_| "Artifact directory entry could not be synced.")
}

#[cfg(test)]
#[path = "retrieval_tests.rs"]
mod tests;
