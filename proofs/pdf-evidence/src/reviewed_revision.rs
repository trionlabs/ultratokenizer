//! Verification of one explicitly approved signed revision in a complete file.
//!
//! Until a general incremental-update policy is reviewed, a caller must obtain
//! independent approval of the complete file digest and selected revision end.
//! Supplying one's own digest as witness data does not establish that approval.
//! A future claim guest must verify an institution signature over these values
//! (or bind them to an approved policy) before using this primitive for issuance.

use crate::{
    cms, verify_covered_pdf, EvidenceError, SignerFingerprint, VerifiedEvidence, MAX_PDF_BYTES,
};
use sha2::{Digest, Sha256};

/// These values must come from an authenticated policy or signed attestation,
/// not from an untrusted applicant's unverified choice of document or revision.
pub struct ApprovedRevision {
    pub full_document_sha256: [u8; 32],
    pub signed_revision_bytes: usize,
    pub signer_fingerprint: SignerFingerprint,
}

/// Only this borrowed prefix is cryptographically authenticated by the leaf.
/// Keeping it attached to the result prevents extracting from an unsigned tail.
/// This type deliberately has no Debug/Serialize implementation for private bytes.
pub struct VerifiedReviewedRevision<'a> {
    revision: &'a [u8],
    evidence: VerifiedEvidence,
    full_document_sha256: [u8; 32],
}

impl VerifiedReviewedRevision<'_> {
    pub fn revision_bytes(&self) -> &[u8] {
        self.revision
    }

    pub fn evidence(&self) -> &VerifiedEvidence {
        &self.evidence
    }

    pub fn full_document_sha256(&self) -> [u8; 32] {
        self.full_document_sha256
    }
}

/// Check the complete-file approval, then verify exactly one complete signed
/// revision under the separately reviewed CAdES envelope. Appended bytes do not
/// inherit the leaf's signature: any change to them invalidates the approval.
/// Only the selected revision is returned for downstream in-guest extraction.
pub fn verify_reviewed_revision<'a>(
    pdf: &'a [u8],
    approval: &ApprovedRevision,
) -> Result<VerifiedReviewedRevision<'a>, EvidenceError> {
    if pdf.is_empty() || pdf.len() > MAX_PDF_BYTES {
        return Err(EvidenceError::InputSize);
    }
    let full_document_sha256: [u8; 32] = Sha256::digest(pdf).into();
    if approval.full_document_sha256 == [0; 32]
        || full_document_sha256 != approval.full_document_sha256
        || approval.signed_revision_bytes == 0
        || approval.signed_revision_bytes > pdf.len()
    {
        return Err(EvidenceError::RevisionNotApproved);
    }
    let revision = &pdf[..approval.signed_revision_bytes];
    let evidence = verify_covered_pdf(
        revision,
        &approval.signer_fingerprint,
        cms::CmsProfile::ReviewedCades,
        2,
    )?;
    Ok(VerifiedReviewedRevision {
        revision,
        evidence,
        full_document_sha256,
    })
}
