//! Request-bound verification of an explicitly synthetic signed gold certificate.
//! A source snapshot is not a backing reserve. Consumers must check source policy,
//! issuer authorization, expiry and single-use claim consumption independently.

mod capsule;
pub mod claim_identity;
pub mod request;

use capsule::Capsule;
pub use capsule::{CAPSULE_BYTES, CAPSULE_MARKER};
pub use claim_identity::{claim_usage_id, CLAIM_USAGE_TYPE};
use request::{word_u64, Request, Word, MAX_REQUEST_BYTES};
use tiny_keccak::{Hasher, Keccak};
use ultratokenizer_pdf_evidence::verify_pdf;

pub const PROFILE_VERSION: u32 = 2;
pub const PUBLIC_VALUES_BYTES: usize = 224;
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;
pub const MAX_WITNESS_BYTES: usize = 48 + MAX_REQUEST_BYTES + MAX_DOCUMENT_BYTES;
pub const WITNESS_MAGIC: &[u8; 8] = b"UTCL0001";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimError {
    InputSize,
    InvalidWitness,
    InvalidRequest,
    InvalidEvidence,
    InvalidCapsule,
    ClaimMismatch,
    AmountMismatch,
    ExpiryMismatch,
}
type Result<T> = std::result::Result<T, ClaimError>;

impl std::fmt::Display for ClaimError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InputSize => "Input exceeds the supported limit.",
            Self::InvalidWitness => "Claim witness encoding is invalid.",
            Self::InvalidRequest => "Issuance request is invalid.",
            Self::InvalidEvidence => "Signed PDF evidence was rejected.",
            Self::InvalidCapsule => "Synthetic certificate capsule is invalid.",
            Self::ClaimMismatch => "The request does not match the authenticated claim.",
            Self::AmountMismatch => "The request must equal the complete authenticated amount.",
            Self::ExpiryMismatch => "The request exceeds the claim validity period.",
        })
    }
}
impl std::error::Error for ClaimError {}

pub fn hash(bytes: &[u8]) -> Word {
    let mut result = [0; 32];
    let mut keccak = Keccak::v256();
    keccak.update(bytes);
    keccak.finalize(&mut result);
    result
}

/// Borrowed witness slices avoid serde-controlled allocation of the PDF buffer.
pub struct ClaimInput<'a> {
    pub approved_signer: Word,
    pub request_json: &'a [u8],
    pub pdf_bytes: &'a [u8],
}

impl<'a> ClaimInput<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() > MAX_WITNESS_BYTES {
            return Err(ClaimError::InputSize);
        }
        if bytes.len() < 48 || &bytes[..8] != WITNESS_MAGIC {
            return Err(ClaimError::InvalidWitness);
        }
        let request_len = u32::from_be_bytes(
            bytes[40..44]
                .try_into()
                .map_err(|_| ClaimError::InvalidWitness)?,
        ) as usize;
        let pdf_len = u32::from_be_bytes(
            bytes[44..48]
                .try_into()
                .map_err(|_| ClaimError::InvalidWitness)?,
        ) as usize;
        if request_len == 0
            || request_len > MAX_REQUEST_BYTES
            || pdf_len == 0
            || pdf_len > MAX_DOCUMENT_BYTES
        {
            return Err(ClaimError::InputSize);
        }
        if bytes.len() != 48 + request_len + pdf_len {
            return Err(ClaimError::InvalidWitness);
        }
        Ok(Self {
            approved_signer: bytes[8..40]
                .try_into()
                .map_err(|_| ClaimError::InvalidWitness)?,
            request_json: &bytes[48..48 + request_len],
            pdf_bytes: &bytes[48 + request_len..],
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.request_json.is_empty()
            || self.request_json.len() > MAX_REQUEST_BYTES
            || self.pdf_bytes.is_empty()
            || self.pdf_bytes.len() > MAX_DOCUMENT_BYTES
        {
            return Err(ClaimError::InputSize);
        }
        let mut result = Vec::with_capacity(48 + self.request_json.len() + self.pdf_bytes.len());
        result.extend_from_slice(WITNESS_MAGIC);
        result.extend_from_slice(&self.approved_signer);
        result.extend_from_slice(&(self.request_json.len() as u32).to_be_bytes());
        result.extend_from_slice(&(self.pdf_bytes.len() as u32).to_be_bytes());
        result.extend_from_slice(self.request_json);
        result.extend_from_slice(self.pdf_bytes);
        Ok(result)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedClaim {
    pub request_digest: Word,
    pub signer_fingerprint: Word,
    pub source_id: Word,
    pub claim_usage_id: Word,
    pub claim_commitment: Word,
    pub claim_valid_until: u64,
}

impl VerifiedClaim {
    pub fn public_values(&self) -> [u8; PUBLIC_VALUES_BYTES] {
        let mut result = [0; PUBLIC_VALUES_BYTES];
        let words = [
            word_u64(u64::from(PROFILE_VERSION)),
            self.request_digest,
            self.signer_fingerprint,
            self.source_id,
            self.claim_usage_id,
            self.claim_commitment,
            word_u64(self.claim_valid_until),
        ];
        for (target, word) in result.chunks_exact_mut(32).zip(words) {
            target.copy_from_slice(&word);
        }
        result
    }
}

pub fn verify_claim(input: &ClaimInput<'_>) -> Result<VerifiedClaim> {
    if input.pdf_bytes.is_empty() || input.pdf_bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(ClaimError::InputSize);
    }
    let request = Request::from_json(input.request_json)?;
    let evidence = verify_pdf(input.pdf_bytes, &input.approved_signer)
        .map_err(|_| ClaimError::InvalidEvidence)?;
    // The required capsule is immediately after the exact PDF header. Coverage
    // excludes only hexadecimal CMS bytes, so this capsule is authenticated.
    let claim = Capsule::parse(input.pdf_bytes)?;
    if request.recipient != claim.holder
        || request.issuer_id != claim.issuer_id
        || request.claim_commitment != claim.commitment()
        || request.claim_usage_id != claim.usage_id()
    {
        return Err(ClaimError::ClaimMismatch);
    }
    if request.amount != claim.capacity {
        return Err(ClaimError::AmountMismatch);
    }
    if request.valid_until > claim.valid_until {
        return Err(ClaimError::ExpiryMismatch);
    }
    Ok(VerifiedClaim {
        request_digest: request.digest(),
        signer_fingerprint: evidence.signer_fingerprint,
        source_id: claim.source_id,
        claim_usage_id: claim.usage_id(),
        claim_commitment: claim.commitment(),
        claim_valid_until: claim.valid_until,
    })
}
