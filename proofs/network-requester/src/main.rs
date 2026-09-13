//! Credential-bearing Succinct mainnet boundary for a reviewed synthetic request.

mod direct;
mod disclosure;
mod journal;
mod paid;
mod paid_journal;
mod paid_rpc;
mod paid_state;
mod retrieval;
mod stage;

use serde::Serialize;
use sha2::{Digest, Sha256};
use sp1_sdk::network::{
    proto::{types::ProofMode, GetProofRequestParamsResponse},
    signer::NetworkSigner,
    NetworkClient, NetworkMode, B256,
};
use std::{
    env,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};
use ultratokenizer_network_request_schema::{
    decimal_gte, format_prove, maximum_cost, normalize_address, parse_canonical_u64,
    require_suffix, Preparation, Quote, EXPECTED_PROGRAM_VKEY, MAX_JOURNAL_BYTES,
    PREPARATION_SUFFIX, QUOTE_SCHEMA_VERSION, QUOTE_SUFFIX,
};

const QUOTE_REVIEW_SECONDS: u64 = 300;

pub(crate) fn read_bounded(path: &str, maximum: usize) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Unable to open journal.")?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read journal.")?;
    if bytes.len() > maximum {
        return Err("Journal exceeds its size limit.");
    }
    Ok(bytes)
}

fn write_json_new<T: Serialize>(path: &Path, value: &T) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Unable to encode quote journal.")?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Quote journal already exists or cannot be created.")?;
    file.write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|_| "Unable to write quote journal.")?;
    file.sync_all()
        .map_err(|_| "Unable to flush quote journal.")
}

pub(crate) fn unix_time() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "System clock is before the Unix epoch.")
}

fn hex_prefixed(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn address_hex(bytes: &[u8]) -> Result<String, &'static str> {
    if bytes.len() != 20 {
        return Err("Succinct returned a malformed authority address.");
    }
    normalize_address(&hex_prefixed(bytes))
}

fn validate_network_params(
    domain: &[u8],
    auctioneer: &[u8],
    executor: &[u8],
    verifier: &[u8],
    treasury: &[u8],
) -> Result<(), &'static str> {
    if domain.is_empty() || domain.len() > 256 {
        return Err("Succinct returned a malformed auction domain.");
    }
    for address in [auctioneer, executor, verifier, treasury] {
        address_hex(address)?;
    }
    Ok(())
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

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn operation_id(preparation_id: &str, requester: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"ultratokenizer-sp1-network-staging-v1");
    for value in [preparation_id.as_bytes(), requester.as_bytes()] {
        hash.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
        hash.update(value);
    }
    format!("0x{}", hex::encode(hash.finalize()))
}

pub(crate) fn read_preparation(path: &str) -> Result<Preparation, &'static str> {
    require_suffix(path, PREPARATION_SUFFIX)?;
    let preparation: Preparation = serde_json::from_slice(&read_bounded(path, MAX_JOURNAL_BYTES)?)
        .map_err(|_| "Invalid SP1 Network preparation journal.")?;
    preparation.validate_synthetic()?;
    Ok(preparation)
}

fn initialize_tls() -> Result<(), &'static str> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "Unable to install the required Rustls crypto provider.")
}

async fn quote(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[3], QUOTE_SUFFIX)?;
    let preparation = read_preparation(&args[1])?;

    let expected_requester = normalize_address(&args[2])?;
    let private_key = env::var("NETWORK_PRIVATE_KEY")
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or("NETWORK_PRIVATE_KEY is required for requester identity verification.")?;
    let signer = NetworkSigner::local(&private_key)
        .map_err(|_| "NETWORK_PRIVATE_KEY is not a valid requester key.")?;
    let actual_requester = format!("{:#x}", signer.address()).to_ascii_lowercase();
    if actual_requester != expected_requester {
        return Err("Requester key does not match the explicitly authorized address.");
    }

    let client = NetworkClient::new(
        signer,
        sp1_sdk::network::get_default_rpc_url_for_mode(NetworkMode::Mainnet),
        NetworkMode::Mainnet,
    );
    let params = client
        .get_proof_request_params(ProofMode::Groth16)
        .await
        .map_err(|_| "Unable to read current Groth16 auction parameters.")?;
    let GetProofRequestParamsResponse::Auction(params) = params else {
        return Err("Succinct mainnet did not return auction parameters.");
    };
    validate_network_params(
        &params.domain,
        &params.auctioneer,
        &params.executor,
        &params.verifier,
        &params.treasury,
    )?;
    let base_fee = parse_canonical_u64(&params.base_fee)
        .map_err(|_| "Succinct returned an unsupported base fee.")?;
    let max_price_per_pgu = parse_canonical_u64(&params.max_price_per_pgu)
        .map_err(|_| "Succinct returned an unsupported PGU price.")?;
    let max_request_cost = maximum_cost(preparation.gas_limit_pgu, base_fee, max_price_per_pgu)?;
    let balance = client
        .get_balance()
        .await
        .map_err(|_| "Unable to read requester PROVE balance.")?
        .to_string();
    if !balance.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Succinct returned a malformed requester balance.");
    }
    let program = client
        .get_program(program_hash()?)
        .await
        .map_err(|_| "Unable to read synthetic program registration status.")?;
    let registered_program_uri = program.as_ref().map(|entry| entry.program_uri().to_owned());
    if registered_program_uri.as_deref() == Some("") {
        return Err("Succinct returned a malformed registered program.");
    }

    let observed_at_unix = unix_time()?;
    let quote = Quote {
        schema_version: QUOTE_SCHEMA_VERSION,
        status: "quoted_no_submission".into(),
        quote_id: String::new(),
        preparation_id: preparation.preparation_id.clone(),
        observed_at_unix,
        review_valid_until_unix: observed_at_unix
            .checked_add(QUOTE_REVIEW_SECONDS)
            .ok_or("Quote timestamp overflowed.")?,
        network: "succinct-mainnet".into(),
        requester: actual_requester,
        proof_mode: "groth16".into(),
        cycle_limit: preparation.cycle_limit,
        gas_limit_pgu: preparation.gas_limit_pgu,
        base_fee_wei: base_fee.to_string(),
        max_price_per_pgu_wei: max_price_per_pgu.to_string(),
        max_request_cost_wei: max_request_cost.to_string(),
        max_request_cost_prove: format_prove(max_request_cost),
        requester_balance_sufficient: decimal_gte(&balance, &max_request_cost.to_string()),
        requester_balance_wei: balance,
        program_registered: program.is_some(),
        registered_program_uri,
        domain: hex_prefixed(&params.domain),
        auctioneer: address_hex(&params.auctioneer)?,
        executor: address_hex(&params.executor)?,
        verifier: address_hex(&params.verifier)?,
        treasury: address_hex(&params.treasury)?,
        network_upload_occurred: false,
        proof_request_submitted: false,
    }
    .seal();
    quote.validate(&preparation)?;
    write_json_new(Path::new(&args[3]), &quote)?;
    println!(
        "{}",
        serde_json::json!({
            "status": quote.status,
            "quoteId": quote.quote_id,
            "requester": quote.requester,
            "gasLimitPgu": quote.gas_limit_pgu,
            "maxRequestCostWei": quote.max_request_cost_wei,
            "maxRequestCostProve": quote.max_request_cost_prove,
            "requesterBalanceSufficient": quote.requester_balance_sufficient,
            "programRegistered": quote.program_registered,
            "reviewValidUntilUnix": quote.review_valid_until_unix,
            "networkUploadOccurred": false,
            "proofRequestSubmitted": false,
        })
    );
    Ok(())
}

async fn retrieve_proof(args: &[String]) -> Result<(), &'static str> {
    let admission: retrieval::OriginAdmission =
        serde_json::from_slice(&read_bounded(&args[3], 16 * 1024)?)
            .map_err(|_| "Invalid reviewed artifact origin admission.")?;
    admission.validate()?;
    paid_state::lower_hash(&args[2])?;
    let mut transport = retrieval::HttpsArtifacts::new()?;
    let mut network = paid_rpc::DirectPaidRpc::connect().await?;
    let receipt = retrieval::retrieve_once(
        Path::new(&args[1]),
        &args[2],
        &admission,
        retrieval::OutputPaths {
            raw: Path::new(&args[4]),
            normalized: Path::new(&args[5]),
            receipt: Path::new(&args[6]),
        },
        &mut network,
        &mut transport,
    )
    .await?;
    println!(
        "{}",
        serde_json::to_string(&receipt).map_err(|_| "Unable to encode retrieval result.")?
    );
    Ok(())
}

async fn run() -> Result<(), &'static str> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("quote") if args.len() == 4 => {
            initialize_tls()?;
            quote(&args).await
        }
        Some("quote") => Err(
            "Usage: network-requester quote <preparation-file> <expected-requester-address> <new-quote-file>",
        ),
        Some("stage-reviewed-public-synthetic") if args.len() == 11 => {
            initialize_tls()?;
            stage::run(&args).await
        }
        Some("stage-reviewed-public-synthetic") => Err(
            "Usage: network-requester stage-reviewed-public-synthetic <preparation-file> <expected-requester-address> <elf> <new-staging-journal> <review-json> <review-sha256> <synthetic-pdf> <request-json> <public-disclosure-json> <public-disclosure-sha256>",
        ),
        Some("stage-reviewed-synthetic") if args.len() == 9 => {
            initialize_tls()?;
            stage::run(&args).await
        }
        Some("stage-reviewed-synthetic") => Err(
            "Usage: network-requester stage-reviewed-synthetic <preparation-file> <expected-requester-address> <elf> <new-staging-journal> <review-json> <review-sha256> <synthetic-pdf> <request-json>",
        ),
        Some("stage") if args.len() == 5 => {
            initialize_tls()?;
            stage::run(&args).await
        }
        Some("stage") => Err(
            "Usage: network-requester stage <preparation-file> <expected-requester-address> <elf> <new-staging-journal>",
        ),
        Some("inspect-stage") if args.len() == 2 => stage::inspect(&args),
        Some("inspect-stage") => Err(
            "Usage: network-requester inspect-stage <staging-journal>",
        ),
        Some("init-budget") if args.len() == 5 => paid::init_budget(&args),
        Some("init-budget") => Err(
            "Usage: network-requester init-budget <expected-requester> <single-cap-wei> <total-cap-wei> <new-budget-journal>",
        ),
        Some("prepare-request") if args.len() == 7 => paid::prepare(&args),
        Some("prepare-request") => Err(
            "Usage: network-requester prepare-request <preparation> <quote> <completed-stage> <reviewed-settings> <existing-budget> <new-request-journal>",
        ),
        Some("submit-request") if args.len() == 3 => {
            initialize_tls()?;
            paid::submit(&args).await
        }
        Some("submit-request") => Err(
            "Usage: network-requester submit-request <prepared-request-journal> <existing-budget-journal>",
        ),
        Some("recover-request") if args.len() == 2 => {
            initialize_tls()?;
            paid::recover(&args).await
        }
        Some("recover-request") => Err(
            "Usage: network-requester recover-request <existing-request-journal>",
        ),
        Some("retrieve-proof") if args.len() == 7 => {
            initialize_tls()?;
            retrieve_proof(&args).await
        }
        Some("retrieve-proof") => Err(
            "Usage: network-requester retrieve-proof <fulfilled-request-journal> <expected-journal-sha256> <reviewed-origin-json> <new-raw-proof> <new-normalized-proof> <new-retrieval-receipt>",
        ),
        _ => Err(
            "Available commands: quote, stage, stage-reviewed-synthetic, stage-reviewed-public-synthetic, inspect-stage, init-budget, prepare-request, submit-request, recover-request, retrieve-proof. Paid submission requires an explicitly reviewed budget and fresh exact quote.",
        ),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn authority_addresses_and_domains_fail_closed() {
        assert!(validate_network_params(&[], &[1; 20], &[2; 20], &[3; 20], &[4; 20]).is_err());
        assert!(validate_network_params(&[1], &[1; 19], &[2; 20], &[3; 20], &[4; 20]).is_err());
        assert!(validate_network_params(&[1], &[1; 20], &[2; 20], &[3; 20], &[4; 20]).is_ok());
    }

    #[test]
    fn pinned_program_key_decodes_to_one_word() {
        assert_eq!(program_hash().unwrap().as_slice().len(), 32);
    }

    #[test]
    fn staging_operation_identity_is_domain_separated_and_deterministic() {
        let first = operation_id("preparation", "requester");
        assert_eq!(first, operation_id("preparation", "requester"));
        assert_ne!(first, operation_id("preparation-2", "requester"));
        assert_ne!(first, operation_id("preparation", "requester-2"));
        assert!(first.starts_with("0x"));
        assert_eq!(first.len(), 66);
    }
}
