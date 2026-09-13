//! Offline reviewed preparation, one signed submission, and unsigned exact recovery.

use crate::{
    journal::{self, StageEventBody},
    paid_journal::Journal,
    paid_rpc::{DirectPaidRpc, PaidRpc, PaidSigner},
    paid_state::*,
    read_bounded, read_preparation, sha256_hex, unix_time,
};
use prost::Message;
use sp1_sdk::network::{proto::auction::types as rpc, signer::NetworkSigner};
use std::{collections::BTreeSet, path::Path};
use ultratokenizer_network_request_schema::{
    decimal_gte, normalize_address, require_suffix, Quote, MAX_JOURNAL_BYTES, QUOTE_SUFFIX,
};

pub fn init_budget(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[4], BUDGET_SUFFIX)?;
    let requester = normalize_address(&args[1])?;
    let single = positive_decimal(&args[2])?;
    let total = positive_decimal(&args[3])?;
    if single > total {
        return Err("Single-request cap exceeds the total-attempt cap.");
    }
    let journal = Journal::create(
        Path::new(&args[4]),
        BudgetEvent::Created {
            network: "succinct-mainnet".into(),
            requester,
            single_cap_wei: single.to_string(),
            total_cap_wei: total.to_string(),
        },
        unix_time()?,
    )?;
    let budget = Budget::read(journal.events())?;
    println!(
        "{}",
        serde_json::json!({"status":"budget_created_no_network", "budgetId":budget.id,
        "singleCapWei":single.to_string(), "totalCapWei":total.to_string(), "proofRequestSubmitted":false})
    );
    Ok(())
}

pub fn prepare(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[2], QUOTE_SUFFIX)?;
    require_suffix(&args[3], journal::STAGING_SUFFIX)?;
    require_suffix(&args[4], SETTINGS_SUFFIX)?;
    require_suffix(&args[5], BUDGET_SUFFIX)?;
    require_suffix(&args[6], REQUEST_SUFFIX)?;
    let preparation = read_preparation(&args[1])?;
    let quote_bytes = read_bounded(&args[2], MAX_JOURNAL_BYTES)?;
    let quote: Quote =
        serde_json::from_slice(&quote_bytes).map_err(|_| "Invalid quote journal.")?;
    let settings: Settings = serde_json::from_slice(&read_bounded(&args[4], 16 * 1024)?)
        .map_err(|_| "Invalid reviewed submission settings.")?;
    let stage_bytes = read_bounded(&args[3], 1024 * 1024)?;
    if sha256_hex(&quote_bytes) != settings.quote_file_sha256
        || sha256_hex(&stage_bytes) != settings.staging_journal_sha256
    {
        return Err("Quote or staging file differs from its explicitly reviewed exact hash.");
    }
    let stages = journal::parse(&stage_bytes)?;
    let first = stages.first().ok_or("Missing staging intent.")?;
    let StageEventBody::Intent {
        preparation_id,
        requester,
        elf_sha256,
        witness_sha256,
        public_disclosure,
        ..
    } = &first.body
    else {
        return Err("Missing staging intent.");
    };
    if preparation_id != &preparation.preparation_id
        || requester != &quote.requester
        || elf_sha256 != &preparation.elf_sha256
        || witness_sha256 != &preparation.witness_sha256
        || first.operation_id
            != crate::disclosure::operation_id(
                preparation_id,
                requester,
                public_disclosure.as_ref(),
            )?
    {
        return Err("Staged program and witness do not match this preparation and requester.");
    }
    let last = stages.last().ok_or("Missing staging completion.")?;
    if first.at_unix < preparation.created_at_unix || last.at_unix > quote.observed_at_unix {
        return Err("A fresh quote after the completed stage is required.");
    }
    let StageEventBody::Complete {
        program_uri,
        stdin_uri,
        ..
    } = &last.body
    else {
        return Err("Staging is not definitively complete; no paid request may be prepared.");
    };
    // Acquire the budget lock before creating the request. This is the lock order
    // used by submit too; competing processes cannot exceed the local total cap.
    let mut budget_log = Journal::<BudgetEvent>::open(Path::new(&args[5]))?;
    let budget = Budget::read(budget_log.events())?;
    let plan = Plan {
        plan_id: String::new(),
        budget_id: budget.id.clone(),
        request_identity: String::new(),
        preparation,
        quote,
        settings,
        program_uri: program_uri.clone(),
        stdin_uri: stdin_uri.clone(),
        public_disclosure: public_disclosure.clone(),
    }
    .seal()?;
    plan.validate()?;
    let now = unix_time()?;
    plan.fresh(now)?;
    budget.can_reserve(&plan)?;
    let _request_log = Journal::create(
        Path::new(&args[6]),
        RequestEvent::Prepared {
            plan: Box::new(plan.clone()),
        },
        now,
    )?;
    // A failure here leaves a prepared file without spending permission. The caller
    // must not recreate a budget or request to bypass that deliberately locked state.
    budget_log.append(
        BudgetEvent::Reserved {
            plan_id: plan.plan_id.clone(),
            request_identity: plan.request_identity.clone(),
            maximum_cost_wei: plan.quote.max_request_cost_wei.clone(),
        },
        now,
    )?;
    println!(
        "{}",
        serde_json::json!({"status":"prepared_no_signature_no_network", "planId":plan.plan_id,
        "budgetId":budget.id, "maximumCostWei":plan.quote.max_request_cost_wei,
        "deadlineUnix":plan.settings.deadline_unix, "proofRequestSubmitted":false})
    );
    Ok(())
}

pub async fn submit(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[1], REQUEST_SUFFIX)?;
    require_suffix(&args[2], BUDGET_SUFFIX)?;
    let budget_log = Journal::<BudgetEvent>::open(Path::new(&args[2]))?;
    let budget = Budget::read(budget_log.events())?;
    let mut request_log = Journal::<RequestEvent>::open(Path::new(&args[1]))?;
    let state = RequestState::read(request_log.events())?;
    budget.require_reservation(&state.plan, budget_log.events())?;
    if state.nonce.is_some() {
        return Err(
            "A signing attempt is already durable; use recover-request and never submit again.",
        );
    }
    state.plan.fresh(unix_time()?)?;
    // Only this explicitly paid command loads the key. Offline preparation and
    // unsigned recovery neither inspect the environment nor construct a signer.
    let private_key = std::env::var("NETWORK_PRIVATE_KEY")
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or(
            "NETWORK_PRIVATE_KEY is required for the explicitly authorized one-shot submission.",
        )?;
    let signer = NetworkSigner::local(&private_key)
        .map_err(|_| "NETWORK_PRIVATE_KEY is not a valid requester key.")?;
    if PaidSigner::address(&signer) != state.plan.quote.requester {
        return Err("Requester key does not match the reviewed request and budget.");
    }
    let mut network = DirectPaidRpc::connect().await?;
    let (request_id, transaction_hash) =
        submit_once(&mut request_log, &mut network, &signer, unix_time).await?;
    println!(
        "{}",
        serde_json::json!({"status":"submission_acknowledged_unverified", "requestId":request_id,
        "transactionHash":transaction_hash, "proofVerified":false, "automaticRetryAllowed":false})
    );
    Ok(())
}

pub async fn submit_once<L: RequestLog, R: PaidRpc, S: PaidSigner>(
    log: &mut L,
    network: &mut R,
    signer: &S,
    clock: impl Fn() -> Result<u64, &'static str>,
) -> Result<(String, String), &'static str> {
    let state = RequestState::read(log.events())?;
    if state.nonce.is_some() {
        return Err("Signing already began; an automatic resend or nonce refresh is forbidden.");
    }
    if signer.address() != state.plan.quote.requester {
        return Err("Wrong requester signer.");
    }
    state.plan.fresh(clock()?)?;
    let body_template = state.plan.body(0)?;
    let params = network.params().await?;
    if params.domain != body_template.domain
        || params.auctioneer != body_template.auctioneer
        || params.executor != body_template.executor
        || params.verifier != body_template.verifier
        || params.treasury != body_template.treasury
        || params.base_fee != body_template.base_fee
        || params.max_price_per_pgu != body_template.max_price_per_pgu
    {
        return Err("Current auction authority or fees differ from the exact reviewed quote; no request was sent.");
    }
    let program = network
        .program(body_template.vk_hash.clone())
        .await?
        .ok_or("Reviewed program is no longer registered.")?;
    if program.vk_hash != body_template.vk_hash || program.program_uri != state.plan.program_uri {
        return Err("Current program registration differs from the reviewed stage.");
    }
    let requester = decode_prefixed(&state.plan.quote.requester)?;
    let balance = network.balance(requester.clone()).await?;
    if balance.is_empty()
        || balance.len() > 78
        || !balance.bytes().all(|v| v.is_ascii_digit())
        || !decimal_gte(&balance, &state.plan.quote.max_request_cost_wei)
    {
        return Err("Current requester balance cannot cover the reviewed maximum.");
    }
    let nonce = network.nonce(requester).await?; // Exactly one read, before durable signing intent.
    let body = state.plan.body(nonce)?;
    let body_bytes = body.encode_to_vec();
    let now = clock()?;
    state.plan.fresh(now)?;
    log.append(
        RequestEvent::SigningIntent {
            nonce,
            body_hex: hex::encode(&body_bytes),
            body_sha256: sha256_hex(&body_bytes),
        },
        now,
    )?;
    let signature = signer.sign(&body_bytes).await?;
    let request = rpc::RequestProofRequest {
        format: rpc::MessageFormat::Binary.into(),
        signature,
        body: Some(body),
    };
    validate_signature(&state.plan, nonce, &request)?;
    let request_bytes = request.encode_to_vec();
    let request_sha256 = sha256_hex(&request_bytes);
    let now = clock()?;
    state.plan.fresh(now)?;
    log.append(
        RequestEvent::Signed {
            request_hex: hex::encode(&request_bytes),
            request_sha256: request_sha256.clone(),
        },
        now,
    )?;
    let now = clock()?;
    state.plan.fresh(now)?;
    log.append(RequestEvent::DispatchAttempted { request_sha256 }, now)?;
    // Recheck after a potentially slow fsync. A deadline failure here is retained as
    // an attempted/uncertain state, never converted into permission to try again.
    state.plan.fresh(clock()?)?;
    let response = network.submit_once(request).await?;
    let transaction_hash = word(&response.tx_hash)?;
    let request_id = word(
        &response
            .body
            .ok_or("Submission response is incomplete; recover without retry.")?
            .request_id,
    )?;
    log.append(
        RequestEvent::Acknowledged {
            request_id: request_id.clone(),
            transaction_hash: transaction_hash.clone(),
        },
        clock()?,
    )?;
    Ok((request_id, transaction_hash))
}

pub async fn recover(args: &[String]) -> Result<(), &'static str> {
    require_suffix(&args[1], REQUEST_SUFFIX)?;
    let mut log = Journal::<RequestEvent>::open(Path::new(&args[1]))?;
    let state = RequestState::read(log.events())?;
    if state.signed.is_none() {
        return Err("No signed request is durably recorded; this command cannot prove absence or release budget.");
    }
    let mut network = DirectPaidRpc::connect().await?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        recover_once(&mut log, &mut network, unix_time),
    )
    .await
    .map_err(|_| {
        "Bounded recovery timed out; no absence is inferred and the budget remains encumbered."
    })??;
    println!("{}", result);
    Ok(())
}

pub async fn recover_once<L: RequestLog, R: PaidRpc>(
    log: &mut L,
    network: &mut R,
    clock: impl Fn() -> Result<u64, &'static str>,
) -> Result<serde_json::Value, &'static str> {
    let state = RequestState::read(log.events())?;
    let signed = state
        .signed
        .as_ref()
        .ok_or("No durable signed request is available for exact recovery.")?;
    let body = signed.body.as_ref().ok_or("Signed body is missing.")?;
    let mut matched = None;
    let mut transaction_reads = 0;
    if let Some((request_id, _)) = state.known.as_ref().or(state.acknowledged.as_ref()) {
        if let Some(candidate) = network.request(decode_prefixed(request_id)?).await? {
            if exact_request(&state.plan, body, &candidate)?
                && exact_transaction(
                    network,
                    &state.plan,
                    signed,
                    &candidate,
                    &mut transaction_reads,
                )
                .await?
            {
                matched = Some(candidate);
            }
        }
        if state.known.is_some() && matched.is_none() {
            return Err(
                "Previously recovered request no longer matches; retain its identity and budget.",
            );
        }
    }
    if matched.is_none() {
        let mut seen = BTreeSet::new();
        let mut completed = false;
        for page in 1..=5 {
            let candidates = network
                .requests(rpc::GetFilteredProofRequestsRequest {
                    requester: Some(decode_prefixed(&state.plan.quote.requester)?),
                    vk_hash: Some(body.vk_hash.clone()),
                    version: Some(body.version.clone()),
                    mode: Some(body.mode),
                    from: Some(state.plan.quote.observed_at_unix.saturating_sub(60)),
                    to: Some(body.deadline.saturating_add(60)),
                    limit: Some(100),
                    page: Some(page),
                    ..Default::default()
                })
                .await?;
            if candidates.len() > 100 {
                return Err("Recovery response exceeds its bounded page size.");
            }
            let last = candidates.len() < 100;
            for candidate in candidates {
                let id = word(&candidate.request_id)?;
                if !seen.insert(id) {
                    return Err(
                        "Recovery pages overlap or repeat; no absence or unique match is asserted.",
                    );
                }
                if exact_request(&state.plan, body, &candidate)?
                    && exact_transaction(
                        network,
                        &state.plan,
                        signed,
                        &candidate,
                        &mut transaction_reads,
                    )
                    .await?
                {
                    if matched.is_some() {
                        return Err(
                            "Multiple requests match the exact signed intent; preserve ambiguity.",
                        );
                    }
                    matched = Some(candidate);
                }
            }
            if last {
                completed = true;
                break;
            }
        }
        if !completed {
            return Err("Bounded recovery search is incomplete; never infer absence or retry.");
        }
    }
    let request = matched.ok_or("No exact signed request was found; budget stays encumbered and resubmission remains forbidden.")?;
    let request_id = word(&request.request_id)?;
    let transaction_hash = word(&request.tx_hash)?;
    log.append(
        RequestEvent::Recovered {
            request_id: request_id.clone(),
            transaction_hash: transaction_hash.clone(),
        },
        clock()?,
    )?;
    let status = network.status(request.request_id.clone()).await?;
    status_values(status.fulfillment_status, status.execution_status)?;
    if status.request_tx_hash != request.tx_hash || status.deadline != body.deadline {
        return Err("Recovered status does not bind the exact request or expected public values.");
    }
    validate_execution_commitment(body, &request, &status)?;
    let fulfilled = status.fulfillment_status == i32::from(rpc::FulfillmentStatus::Fulfilled);
    if fulfilled
        && (status.execution_status != i32::from(rpc::ExecutionStatus::Executed)
            || status.proof_uri.is_none()
            || status
                .fulfill_tx_hash
                .as_ref()
                .is_none_or(|hash| word(hash).is_err()))
    {
        return Err("Fulfilled status lacks the required execution or artifact metadata; proof remains unverified.");
    }
    if let Some(uri) = &status.proof_uri {
        validate_uri(uri)?;
    }
    let uri_hash = status
        .proof_uri
        .as_ref()
        .map(|uri| sha256_hex(uri.as_bytes()));
    let observed_at_unix = clock()?;
    // Service enums can remain ASSIGNED after the signed deadline. Report the
    // local clock separately; elapsed time never proves settlement or absence.
    let fulfiller = request
        .fulfiller
        .as_deref()
        .and_then(|bytes| crate::address_hex(bytes).ok());
    log.append(
        RequestEvent::Observed {
            request_id: request_id.clone(),
            transaction_hash: transaction_hash.clone(),
            fulfillment_status: status.fulfillment_status,
            execution_status: status.execution_status,
            proof_uri: status.proof_uri,
            proof_uri_sha256: uri_hash.clone(),
        },
        observed_at_unix,
    )?;
    Ok(
        serde_json::json!({"status":"exact_signed_request_observed", "requestId":request_id,
        "transactionHash":transaction_hash, "fulfillmentStatus":status.fulfillment_status,
        "executionStatus":status.execution_status, "proofAvailable":fulfilled,
        "deadlineUnix":body.deadline, "observedAtUnix":observed_at_unix,
        "deadlinePassed":observed_at_unix >= body.deadline,
        "serviceCreatedAtUnix":(request.created_at != 0).then_some(request.created_at),
        "serviceUpdatedAtUnix":(request.updated_at != 0).then_some(request.updated_at),
        "fulfiller":fulfiller,
        "proofUriSha256":uri_hash, "proofDownloaded":false, "proofVerified":false,
        "budgetReleased":false, "automaticRetryAllowed":false}),
    )
}

// The caller must first bind request details to the exact signed body and nonce.
// SP1 SDK 6.2.4 auction ProofRequest field 23 is the execution-result hash.
// The status endpoint may omit its optional field 7 even after execution, so an
// executed details response can supply it. Conflicting returned hashes always fail.
// These are RPC observations; neither response proves the computation is valid.
pub(crate) fn validate_execution_commitment(
    body: &rpc::RequestProofRequestBody,
    request: &rpc::ProofRequest,
    status: &rpc::GetProofRequestStatusResponse,
) -> Result<(), &'static str> {
    let expected = body
        .public_values_hash
        .as_ref()
        .filter(|hash| hash.len() == 32)
        .ok_or("Signed request lacks the expected execution commitment.")?;
    for hash in [
        request.public_values_hash.as_ref(),
        status.public_values_hash.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if hash != expected {
            return Err(
                "Recovered execution commitment differs from the signed expected public values.",
            );
        }
    }
    if status.execution_status == i32::from(rpc::ExecutionStatus::Executed)
        && status.public_values_hash.is_none()
        && !(request.execution_status == i32::from(rpc::ExecutionStatus::Executed)
            && request.public_values_hash.is_some())
    {
        return Err(
            "Executed request lacks a matching execution commitment in both RPC responses.",
        );
    }
    Ok(())
}

fn exact_request(
    plan: &Plan,
    body: &rpc::RequestProofRequestBody,
    request: &rpc::ProofRequest,
) -> Result<bool, &'static str> {
    Ok(request.vk_hash == body.vk_hash
        && request.version == body.version
        && request.mode == body.mode
        && request.strategy == body.strategy
        && request.program_uri == plan.program_uri
        && request.stdin_uri == body.stdin_uri
        && request.deadline == body.deadline
        && request.cycle_limit == body.cycle_limit
        && request.gas_limit == body.gas_limit
        && request.requester == decode_prefixed(&plan.quote.requester)?
        && request.min_auction_period == body.min_auction_period
        && request.whitelist == body.whitelist
        && request.base_fee.as_deref() == Some(&body.base_fee)
        && request.max_price_per_pgu.as_deref() == Some(&body.max_price_per_pgu)
        && request.stdin_private == body.stdin_private)
}

async fn exact_transaction<R: PaidRpc>(
    network: &mut R,
    plan: &Plan,
    signed: &rpc::RequestProofRequest,
    request: &rpc::ProofRequest,
    reads: &mut usize,
) -> Result<bool, &'static str> {
    if *reads >= 8 {
        return Err("Exact transaction recovery limit reached; preserve ambiguity without retrying submission.");
    }
    *reads += 1;
    word(&request.request_id)?;
    word(&request.tx_hash)?;
    let Some(transaction) = network.transaction(request.tx_hash.clone()).await? else {
        return Ok(false);
    };
    Ok(transaction.tx_hash == request.tx_hash
        && transaction.request_id.as_ref() == Some(&request.request_id)
        && transaction.sender == decode_prefixed(&plan.quote.requester)?
        && transaction.nonce
            == signed
                .body
                .as_ref()
                .ok_or("Missing durable request body.")?
                .nonce
        && transaction.signature == signed.signature)
}

fn word(bytes: &[u8]) -> Result<String, &'static str> {
    let value = format!("0x{}", hex::encode(bytes));
    prefixed_word(&value).map_err(|_| {
        "Network returned a malformed request or transaction identifier; recover without retry."
    })?;
    Ok(value)
}

#[cfg(test)]
#[path = "paid_tests.rs"]
mod tests;
