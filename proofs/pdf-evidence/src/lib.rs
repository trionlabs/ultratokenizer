//! Verify one RSA-SHA256 signature covering a complete PDF revision.
//!
//! This module does not interpret balances, establish holder identity, validate
//! certificate chains or authorize minting. The caller supplies an approved
//! signer fingerprint; a key embedded in the document is never its own authority.

mod cms;
mod coverage;

use rsa::{pkcs8::EncodePublicKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use signature_validator::{
    pkcs7_parser::parse_signed_data,
    types::{PublicKeyType, SignatureAlgorithm},
    verify_pdf_signature,
};
use std::fmt;

pub const MAX_PDF_BYTES: usize = 4 * 1024 * 1024;
pub const PROFILE_VERSION: u32 = 1;

/// SHA-256 of the RSA public key's canonical X.509 SubjectPublicKeyInfo DER.
pub type SignerFingerprint = [u8; 32];

/// Private SP1 witness. Do not log or send to a remote prover without consent.
#[derive(Serialize, Deserialize)]
pub struct EvidenceInput {
    pub pdf_bytes: Vec<u8>,
    pub approved_signer: SignerFingerprint,
}

/// Error messages deliberately contain no document content or parser diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceError {
    InputSize,
    UnsupportedPdf,
    AmbiguousSignature,
    InvalidByteRange,
    InvalidSignatureGap,
    UnsignedRevision,
    InvalidCms,
    UnsupportedAlgorithm,
    SignerNotAllowed,
    InvalidSignature,
}

impl fmt::Display for EvidenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InputSize => "PDF size is outside the supported limit.",
            Self::UnsupportedPdf => "PDF structure is not supported by this profile.",
            Self::AmbiguousSignature => "Exactly one signature is required by this profile.",
            Self::InvalidByteRange => "Signature byte coverage is invalid.",
            Self::InvalidSignatureGap => "The unsigned gap must contain only the signature value.",
            Self::UnsignedRevision => "The signature must cover the complete supplied revision.",
            Self::InvalidCms => "The signature container is invalid.",
            Self::UnsupportedAlgorithm => "Only RSA-2048/SHA-256 with exponent 65537 is supported.",
            Self::SignerNotAllowed => "The signer does not match the approved fingerprint.",
            Self::InvalidSignature => "The document signature or signed digest is invalid.",
        })
    }
}

impl std::error::Error for EvidenceError {}

/// Deliberately excludes names, account identifiers and extracted document text.
/// The digest is linkable to anyone holding the document; it is not anonymity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedEvidence {
    pub profile_version: u32,
    pub signer_fingerprint: SignerFingerprint,
    pub signed_digest: [u8; 32],
}

impl VerifiedEvidence {
    /// ABI encoding of (uint32 profileVersion, bytes32 signerFingerprint, bytes32 signedDigest).
    pub fn public_values(&self) -> [u8; 96] {
        let mut bytes = [0; 96];
        bytes[28..32].copy_from_slice(&self.profile_version.to_be_bytes());
        bytes[32..64].copy_from_slice(&self.signer_fingerprint);
        bytes[64..96].copy_from_slice(&self.signed_digest);
        bytes
    }
}

/// Verify a leaf signature against an independently approved signer fingerprint.
///
/// The supported profile rejects multiple signatures and appended revisions.
/// Enpara documents require a separately reviewed revision-selection adapter.
pub fn verify_pdf(
    pdf: &[u8],
    approved_signer: &SignerFingerprint,
) -> Result<VerifiedEvidence, EvidenceError> {
    let coverage = coverage::validate(pdf)?;
    let cms = cms::decode_and_validate(&pdf[coverage.gap_start + 1..coverage.gap_end - 1])?;
    let parameters = parse_signed_data(&cms).map_err(|_| EvidenceError::InvalidCms)?;

    if parameters.algorithm != SignatureAlgorithm::Sha256WithRsaEncryption {
        return Err(EvidenceError::UnsupportedAlgorithm);
    }
    let PublicKeyType::Rsa { modulus, exponent } = parameters.public_key else {
        return Err(EvidenceError::UnsupportedAlgorithm);
    };
    // The upstream ASN.1 parser returns a signed integer encoding. A positive
    // 2048-bit RSA modulus has one leading sign byte; reject negative integers.
    let Some(modulus) = modulus.strip_prefix(&[0]) else {
        return Err(EvidenceError::UnsupportedAlgorithm);
    };
    if modulus.len() != 256 || modulus[0] & 0x80 == 0 || exponent.to_bytes_be() != [1, 0, 1] {
        return Err(EvidenceError::UnsupportedAlgorithm);
    }
    let key = RsaPublicKey::new(
        rsa::BigUint::from_bytes_be(modulus),
        rsa::BigUint::from_bytes_be(&exponent.to_bytes_be()),
    )
    .map_err(|_| EvidenceError::InvalidCms)?;
    let spki = key
        .to_public_key_der()
        .map_err(|_| EvidenceError::InvalidCms)?;
    let signer_fingerprint: [u8; 32] = Sha256::digest(spki.as_bytes()).into();
    if approved_signer == &[0; 32] || &signer_fingerprint != approved_signer {
        return Err(EvidenceError::SignerNotAllowed);
    }

    // Independently hash the exact ranges accepted by our stricter coverage parser.
    let mut digest = Sha256::new();
    digest.update(&pdf[..coverage.gap_start]);
    digest.update(&pdf[coverage.gap_end..]);
    let signed_digest: [u8; 32] = digest.finalize().into();
    if parameters.signed_data_message_digest.as_deref() != Some(signed_digest.as_slice()) {
        return Err(EvidenceError::InvalidSignature);
    }
    let signature = verify_pdf_signature(pdf).map_err(|_| EvidenceError::InvalidSignature)?;
    if !signature.is_valid || signature.message_digest != signed_digest {
        return Err(EvidenceError::InvalidSignature);
    }

    Ok(VerifiedEvidence {
        profile_version: PROFILE_VERSION,
        signer_fingerprint,
        signed_digest,
    })
}
