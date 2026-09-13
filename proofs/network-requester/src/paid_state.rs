//! Reviewed request identity, immutable cumulative budget, and one-way paid state.

use crate::{
    paid_journal::{Event, Journal},
    sha256_hex,
};
use alloy_primitives::Signature;
use prost::Message;
use serde::{Deserialize, Serialize};
use sp1_sdk::network::proto::auction::types as rpc;
use std::collections::BTreeSet;
use ultratokenizer_network_request_schema::{
    maximum_cost, normalize_address, parse_canonical_u64, Preparation, Quote,
};

pub const BUDGET_SUFFIX: &str = ".sp1-network-budget.jsonl";
pub const REQUEST_SUFFIX: &str = ".sp1-network-request.jsonl";
pub const SETTINGS_SUFFIX: &str = ".sp1-network-submission.json";
pub const MAX_DEADLINE_SECONDS: u64 = 14_400;
pub const MAX_QUOTE_SECONDS: u64 = 300;
pub const MIN_REMAINING_SECONDS: u64 = 300;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u32,
    pub quote_id: String,
    pub quote_file_sha256: String,
    pub staging_journal_sha256: String,
    pub deadline_unix: u64,
    pub min_auction_period_seconds: u64,
    pub prover_whitelist: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub plan_id: String,
    pub budget_id: String,
    pub request_identity: String,
    pub preparation: Preparation,
    pub quote: Quote,
    pub settings: Settings,
    pub program_uri: String,
    pub stdin_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_disclosure: Option<crate::disclosure::PublicDisclosure>,
}

impl Plan {
    pub fn seal(mut self) -> Result<Self, &'static str> {
        self.request_identity = self.identity()?;
        self.plan_id.clear();
        self.plan_id =
            sha256_hex(&serde_json::to_vec(&self).map_err(|_| "Unable to seal request plan.")?);
        Ok(self)
    }

    fn identity(&self) -> Result<String, &'static str> {
        // Stable across quote, deadline, caps and preparation timestamps. Re-quoting is
        // not permission to pay for the same underlying witness again in this budget.
        let value = (
            &self.preparation.program_v_key,
            &self.preparation.witness_sha256,
            &self.preparation.request_digest,
            &self.preparation.public_values_sha256,
        );
        Ok(sha256_hex(
            &serde_json::to_vec(&value).map_err(|_| "Unable to identify request.")?,
        ))
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.preparation.validate_synthetic()?;
        self.quote.validate(&self.preparation)?;
        if self.clone().seal()?.plan_id != self.plan_id || self.identity()? != self.request_identity
        {
            return Err("Request plan integrity failed.");
        }
        for value in [
            &self.budget_id,
            &self.plan_id,
            &self.request_identity,
            &self.settings.quote_file_sha256,
            &self.settings.staging_journal_sha256,
        ] {
            lower_hash(value)?;
        }
        let public_values = decode_prefixed(&self.preparation.public_values)?;
        if sha256_hex(&public_values) != self.preparation.public_values_sha256 {
            return Err("Preparation public values do not match their SHA-256 commitment.");
        }
        if self.settings.schema_version != 1
            || self.settings.quote_id != self.quote.quote_id
            || self.quote.review_valid_until_unix <= self.quote.observed_at_unix
            || self.quote.review_valid_until_unix - self.quote.observed_at_unix > MAX_QUOTE_SECONDS
            || !self.quote.program_registered
            || !self.quote.requester_balance_sufficient
            || self.quote.registered_program_uri.as_deref() != Some(&self.program_uri)
            || self.preparation.created_at_unix > self.quote.observed_at_unix
        {
            return Err("Request settings do not bind a fresh, funded, registered quote.");
        }
        let span = self
            .settings
            .deadline_unix
            .checked_sub(self.quote.observed_at_unix)
            .ok_or("Request deadline precedes its quote.")?;
        if !(MIN_REMAINING_SECONDS..=MAX_DEADLINE_SECONDS).contains(&span)
            || self.settings.min_auction_period_seconds > span
        {
            return Err("Request deadline or auction period exceeds the reviewed bounds.");
        }
        validate_uri(&self.program_uri)?;
        validate_uri(&self.stdin_uri)?;
        if let Some(disclosure) = &self.public_disclosure {
            disclosure.validate(&self.preparation, &self.quote.requester)?;
        }
        crate::disclosure::validate_stdin_uri(&self.stdin_uri, self.public_disclosure.is_some())?;
        let domain = decode_prefixed(&self.quote.domain)?;
        if domain.is_empty() || domain.len() > 256 {
            return Err("Auction domain is outside its bound.");
        }
        if self.settings.prover_whitelist.len() > 32 {
            return Err("Prover whitelist exceeds its bound.");
        }
        let mut distinct = BTreeSet::new();
        for address in &self.settings.prover_whitelist {
            if normalize_address(address)? != *address || !distinct.insert(address) {
                return Err("Prover whitelist must contain distinct canonical nonzero addresses.");
            }
        }
        self.maximum_cost()?;
        Ok(())
    }

    pub fn fresh(&self, now: u64) -> Result<(), &'static str> {
        if let Some(disclosure) = &self.public_disclosure {
            disclosure.fresh(now)?;
        }
        if now < self.quote.observed_at_unix
            || now >= self.quote.review_valid_until_unix
            || now >= self.settings.deadline_unix
            || self.settings.deadline_unix - now < MIN_REMAINING_SECONDS
            || self.settings.min_auction_period_seconds > self.settings.deadline_unix - now
        {
            return Err(
                "Reviewed quote or safe request deadline expired; no signing or send is allowed.",
            );
        }
        Ok(())
    }

    pub fn maximum_cost(&self) -> Result<u128, &'static str> {
        let cost = maximum_cost(
            self.preparation.gas_limit_pgu,
            parse_canonical_u64(&self.quote.base_fee_wei)?,
            parse_canonical_u64(&self.quote.max_price_per_pgu_wei)?,
        )?;
        if cost == 0 || cost.to_string() != self.quote.max_request_cost_wei {
            return Err("Paid request requires a positive, exact maximum cost.");
        }
        Ok(cost)
    }

    pub fn body(&self, nonce: u64) -> Result<rpc::RequestProofRequestBody, &'static str> {
        Ok(rpc::RequestProofRequestBody {
            nonce,
            vk_hash: decode_prefixed(&self.preparation.program_v_key)?,
            version: format!("sp1-{}", self.preparation.outer_circuit_version),
            mode: rpc::ProofMode::Groth16.into(),
            strategy: rpc::FulfillmentStrategy::Auction.into(),
            stdin_uri: self.stdin_uri.clone(),
            deadline: self.settings.deadline_unix,
            cycle_limit: self.preparation.cycle_limit,
            gas_limit: self.preparation.gas_limit_pgu,
            min_auction_period: self.settings.min_auction_period_seconds,
            whitelist: self
                .settings
                .prover_whitelist
                .iter()
                .map(|v| decode_prefixed(v))
                .collect::<Result<_, _>>()?,
            domain: decode_prefixed(&self.quote.domain)?,
            auctioneer: decode_prefixed(&self.quote.auctioneer)?,
            executor: decode_prefixed(&self.quote.executor)?,
            verifier: decode_prefixed(&self.quote.verifier)?,
            public_values_hash: Some(
                hex::decode(&self.preparation.public_values_sha256)
                    .map_err(|_| "Invalid public values hash.")?,
            ),
            base_fee: self.quote.base_fee_wei.clone(),
            max_price_per_pgu: self.quote.max_price_per_pgu_wei.clone(),
            variant: rpc::TransactionVariant::RequestVariant.into(),
            treasury: decode_prefixed(&self.quote.treasury)?,
            stdin_private: self.public_disclosure.is_none(),
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum BudgetEvent {
    Created {
        network: String,
        requester: String,
        single_cap_wei: String,
        total_cap_wei: String,
    },
    Reserved {
        plan_id: String,
        request_identity: String,
        maximum_cost_wei: String,
    },
}

pub struct Budget {
    pub id: String,
    pub requester: String,
    pub single: u128,
    pub total: u128,
    pub encumbered: u128,
    plans: BTreeSet<String>,
    identities: BTreeSet<String>,
}

impl Budget {
    pub fn read(events: &[Event<BudgetEvent>]) -> Result<Self, &'static str> {
        let first = events.first().ok_or("Budget journal is empty.")?;
        let BudgetEvent::Created {
            network,
            requester,
            single_cap_wei,
            total_cap_wei,
        } = &first.body
        else {
            return Err("Budget must begin with its immutable limits.");
        };
        let single = positive_decimal(single_cap_wei)?;
        let total = positive_decimal(total_cap_wei)?;
        if network != "succinct-mainnet"
            || normalize_address(requester)? != *requester
            || single > total
        {
            return Err("Budget network, requester or limits are invalid.");
        }
        let mut value = Self {
            id: first.event_hash.clone(),
            requester: requester.clone(),
            single,
            total,
            encumbered: 0,
            plans: BTreeSet::new(),
            identities: BTreeSet::new(),
        };
        for event in events.iter().skip(1) {
            let BudgetEvent::Reserved {
                plan_id,
                request_identity,
                maximum_cost_wei,
            } = &event.body
            else {
                return Err("Budget limits cannot be replaced.");
            };
            lower_hash(plan_id)?;
            lower_hash(request_identity)?;
            let cost = positive_decimal(maximum_cost_wei)?;
            if cost > single
                || !value.plans.insert(plan_id.clone())
                || !value.identities.insert(request_identity.clone())
            {
                return Err("Budget contains a duplicate request or an excessive single cost.");
            }
            value.encumbered = value
                .encumbered
                .checked_add(cost)
                .ok_or("Cumulative budget overflowed.")?;
            if value.encumbered > total {
                return Err("Cumulative request budget is exceeded.");
            }
        }
        Ok(value)
    }

    pub fn can_reserve(&self, plan: &Plan) -> Result<(), &'static str> {
        self.bind(plan)?;
        if self.plans.contains(&plan.plan_id) || self.identities.contains(&plan.request_identity) {
            return Err("This budget already contains this request; recover it instead of preparing a retry.");
        }
        if self
            .encumbered
            .checked_add(plan.maximum_cost()?)
            .is_none_or(|sum| sum > self.total)
        {
            return Err("Total request budget would be exceeded.");
        }
        Ok(())
    }

    pub fn require_reservation(
        &self,
        plan: &Plan,
        events: &[Event<BudgetEvent>],
    ) -> Result<(), &'static str> {
        self.bind(plan)?;
        if !events.iter().any(|event| {
            matches!(&event.body, BudgetEvent::Reserved {
            plan_id, request_identity, maximum_cost_wei
        } if plan_id == &plan.plan_id && request_identity == &plan.request_identity
            && maximum_cost_wei == &plan.quote.max_request_cost_wei)
        }) {
            return Err("The exact request has no durable reservation in this budget.");
        }
        Ok(())
    }

    fn bind(&self, plan: &Plan) -> Result<(), &'static str> {
        if self.id != plan.budget_id
            || self.requester != plan.quote.requester
            || plan.maximum_cost()? > self.single
        {
            return Err("Request does not match its immutable budget or single-request cap.");
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestEvent {
    Prepared {
        plan: Box<Plan>,
    },
    SigningIntent {
        nonce: u64,
        body_hex: String,
        body_sha256: String,
    },
    Signed {
        request_hex: String,
        request_sha256: String,
    },
    DispatchAttempted {
        request_sha256: String,
    },
    Acknowledged {
        request_id: String,
        transaction_hash: String,
    },
    Recovered {
        request_id: String,
        transaction_hash: String,
    },
    Observed {
        request_id: String,
        transaction_hash: String,
        fulfillment_status: i32,
        execution_status: i32,
        proof_uri: Option<String>,
        proof_uri_sha256: Option<String>,
    },
}

// The sole production implementation writes/syncs a locked Journal. This interface
// also permits failure injection at the persistence boundary in offline tests.
pub trait RequestLog {
    fn events(&self) -> &[Event<RequestEvent>];
    fn append(&mut self, value: RequestEvent, now: u64) -> Result<(), &'static str>;
}
impl RequestLog for Journal<RequestEvent> {
    fn events(&self) -> &[Event<RequestEvent>] {
        self.events()
    }
    fn append(&mut self, value: RequestEvent, now: u64) -> Result<(), &'static str> {
        self.append(value, now)
    }
}

pub struct RequestState {
    pub plan: Plan,
    pub nonce: Option<u64>,
    pub signed: Option<rpc::RequestProofRequest>,
    pub dispatched: bool,
    pub acknowledged: Option<(String, String)>,
    pub known: Option<(String, String)>,
}

impl RequestState {
    pub fn read(events: &[Event<RequestEvent>]) -> Result<Self, &'static str> {
        let first = events.first().ok_or("Request journal is empty.")?;
        let RequestEvent::Prepared { plan } = &first.body else {
            return Err("Request must begin with its exact prepared intent.");
        };
        plan.validate()?;
        plan.fresh(first.at_unix)?;
        let mut state = Self {
            plan: *plan.clone(),
            nonce: None,
            signed: None,
            dispatched: false,
            acknowledged: None,
            known: None,
        };
        for event in events.iter().skip(1) {
            match &event.body {
                RequestEvent::SigningIntent {
                    nonce,
                    body_hex,
                    body_sha256,
                } if state.nonce.is_none() => {
                    state.plan.fresh(event.at_unix)?;
                    let body = state.plan.body(*nonce)?.encode_to_vec();
                    if hex::encode(&body) != *body_hex || sha256_hex(&body) != *body_sha256 {
                        return Err("Signing intent does not equal the reviewed protobuf body.");
                    }
                    state.nonce = Some(*nonce);
                }
                RequestEvent::Signed {
                    request_hex,
                    request_sha256,
                } if state.nonce.is_some() && state.signed.is_none() => {
                    state.plan.fresh(event.at_unix)?;
                    let bytes = hex::decode(request_hex)
                        .map_err(|_| "Signed request is not hexadecimal.")?;
                    let request = rpc::RequestProofRequest::decode(bytes.as_slice())
                        .map_err(|_| "Signed request protobuf is invalid.")?;
                    if request.encode_to_vec() != bytes || sha256_hex(&bytes) != *request_sha256 {
                        return Err("Signed request hash or canonical encoding failed.");
                    }
                    validate_signature(
                        &state.plan,
                        state.nonce.ok_or("Missing durable nonce.")?,
                        &request,
                    )?;
                    state.signed = Some(request);
                }
                RequestEvent::DispatchAttempted { request_sha256 }
                    if state.signed.is_some() && !state.dispatched =>
                {
                    state.plan.fresh(event.at_unix)?;
                    let bytes = state
                        .signed
                        .as_ref()
                        .ok_or("Missing signed request.")?
                        .encode_to_vec();
                    if sha256_hex(&bytes) != *request_sha256 {
                        return Err("Dispatch does not match the durable signed request.");
                    }
                    state.dispatched = true;
                }
                RequestEvent::Acknowledged {
                    request_id,
                    transaction_hash,
                } if state.dispatched && state.acknowledged.is_none() && state.known.is_none() => {
                    prefixed_word(request_id)?;
                    prefixed_word(transaction_hash)?;
                    // A transport acknowledgement is a lookup hint, not authenticated
                    // recovery evidence. A later exact signature match may correct it.
                    state.acknowledged = Some((request_id.clone(), transaction_hash.clone()));
                }
                RequestEvent::Recovered {
                    request_id,
                    transaction_hash,
                } if state.signed.is_some() => {
                    validate_known(&mut state, request_id, transaction_hash)?;
                }
                RequestEvent::Observed {
                    request_id,
                    transaction_hash,
                    fulfillment_status,
                    execution_status,
                    proof_uri,
                    proof_uri_sha256,
                } if state.known.is_some() => {
                    validate_known(&mut state, request_id, transaction_hash)?;
                    status_values(*fulfillment_status, *execution_status)?;
                    if proof_uri.as_ref().map(|uri| sha256_hex(uri.as_bytes())) != *proof_uri_sha256
                    {
                        return Err("Proof location observation hash failed.");
                    }
                    if let Some(uri) = proof_uri {
                        validate_uri(uri)?;
                    }
                }
                _ => return Err(
                    "Paid request state is inconsistent; signing or sending again is forbidden.",
                ),
            }
        }
        Ok(state)
    }
}

fn validate_known(
    state: &mut RequestState,
    request_id: &str,
    transaction_hash: &str,
) -> Result<(), &'static str> {
    prefixed_word(request_id)?;
    prefixed_word(transaction_hash)?;
    let next = (request_id.to_owned(), transaction_hash.to_owned());
    if state.known.as_ref().is_some_and(|known| known != &next) {
        return Err("Recovery cannot replace the original request identity.");
    }
    state.known = Some(next);
    Ok(())
}

pub fn validate_signature(
    plan: &Plan,
    nonce: u64,
    request: &rpc::RequestProofRequest,
) -> Result<(), &'static str> {
    let expected = plan.body(nonce)?;
    if request.format != i32::from(rpc::MessageFormat::Binary)
        || request.body.as_ref() != Some(&expected)
    {
        return Err("Signed request does not bind every reviewed field.");
    }
    let signature =
        Signature::from_raw(&request.signature).map_err(|_| "Request signature is invalid.")?;
    let signer = signature
        .recover_address_from_msg(expected.encode_to_vec())
        .map_err(|_| "Unable to recover request signer.")?;
    if format!("{signer:#x}") != plan.quote.requester {
        return Err("Request was signed by a different requester.");
    }
    Ok(())
}

pub fn status_values(fulfillment: i32, execution: i32) -> Result<(), &'static str> {
    if rpc::FulfillmentStatus::try_from(fulfillment).is_err()
        || fulfillment == 0
        || rpc::ExecutionStatus::try_from(execution).is_err()
        || execution == 0
    {
        return Err("Network status is unknown; no terminal or proof claim is made.");
    }
    Ok(())
}

pub fn positive_decimal(value: &str) -> Result<u128, &'static str> {
    let parsed = value
        .parse::<u128>()
        .map_err(|_| "Budget must be a canonical positive integer in PROVE wei.")?;
    if parsed == 0 || parsed.to_string() != value {
        return Err("Budget must be a canonical positive integer in PROVE wei.");
    }
    Ok(parsed)
}

pub fn decode_prefixed(value: &str) -> Result<Vec<u8>, &'static str> {
    hex::decode(
        value
            .strip_prefix("0x")
            .ok_or("Expected prefixed hexadecimal value.")?,
    )
    .map_err(|_| "Invalid hexadecimal value.")
}

pub fn lower_hash(value: &str) -> Result<(), &'static str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || value.bytes().all(|v| v == b'0')
    {
        return Err("Expected a nonzero lower-case SHA-256 hash.");
    }
    Ok(())
}

pub fn prefixed_word(value: &str) -> Result<(), &'static str> {
    lower_hash(
        value
            .strip_prefix("0x")
            .ok_or("Expected a prefixed nonzero 32-byte identifier.")?,
    )
}

pub fn validate_uri(uri: &str) -> Result<(), &'static str> {
    if uri.is_empty()
        || uri.len() > 2048
        || uri
            .bytes()
            .any(|v| v.is_ascii_control() || v.is_ascii_whitespace())
    {
        return Err("Artifact URI is absent or outside its safe serialization bounds.");
    }
    Ok(())
}
