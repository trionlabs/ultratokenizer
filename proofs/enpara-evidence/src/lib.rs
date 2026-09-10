//! Experimental, native-only extraction from a cryptographically selected revision.
//! This is not an issuance profile or proof of institution allocation/ownership.
mod content;
mod fonts;
mod layout;
mod pdf;

use sha2::{Digest, Sha256};
use ultratokenizer_pdf_evidence::reviewed_revision::VerifiedReviewedRevision;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Structure,
    Budget,
    Xref,
    DuplicateObject,
    UpdatedObject,
    Stream,
    Font,
    Operator,
    PageGraph,
    Layout,
    Ambiguous,
    Quantity,
    Date,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unsupported or ambiguous Enpara evidence: {self:?}")
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Private statement data. Deliberately no Debug or serialization implementation.
pub struct AvailableXauStatement {
    amount_mg: u64,
    report_date: ReportDate,
    provenance: FieldProvenance,
}
impl AvailableXauStatement {
    pub fn amount_mg(&self) -> u64 {
        self.amount_mg
    }
    pub fn report_date(&self) -> &ReportDate {
        &self.report_date
    }
    pub fn provenance(&self) -> &FieldProvenance {
        &self.provenance
    }
}

/// The report's snapshot date, not a validity period or reservation expiry.
pub struct ReportDate {
    year: u16,
    month: u8,
    day: u8,
}
impl ReportDate {
    pub fn year(&self) -> u16 {
        self.year
    }
    pub fn month(&self) -> u8 {
        self.month
    }
    pub fn day(&self) -> u8 {
        self.day
    }
}

/// Private provenance. Digests are linkable to anyone holding a source document.
pub struct FieldProvenance {
    full_document_sha256: [u8; 32],
    selected_revision_sha256: [u8; 32],
    signed_byte_ranges_sha256: [u8; 32],
    signer_fingerprint: [u8; 32],
    selected_revision_bytes: usize,
    amount: TextLocation,
    row: TextLocation,
    unit: TextLocation,
    column: TextLocation,
    date: TextLocation,
}
impl FieldProvenance {
    pub fn full_document_sha256(&self) -> [u8; 32] {
        self.full_document_sha256
    }
    pub fn selected_revision_sha256(&self) -> [u8; 32] {
        self.selected_revision_sha256
    }
    pub fn signed_byte_ranges_sha256(&self) -> [u8; 32] {
        self.signed_byte_ranges_sha256
    }
    pub fn signer_fingerprint(&self) -> [u8; 32] {
        self.signer_fingerprint
    }
    pub fn selected_revision_bytes(&self) -> usize {
        self.selected_revision_bytes
    }
    pub fn amount(&self) -> &TextLocation {
        &self.amount
    }
    pub fn row(&self) -> &TextLocation {
        &self.row
    }
    pub fn unit(&self) -> &TextLocation {
        &self.unit
    }
    pub fn column(&self) -> &TextLocation {
        &self.column
    }
    pub fn date(&self) -> &TextLocation {
        &self.date
    }
}
/// Offset is in the bounded decoded stream; its object and bytes are authenticated.
pub struct TextLocation {
    page_number: u8,
    content_object: u32,
    font_object: u32,
    operator_offset: usize,
    x_fixed: i64,
    y_fixed: i64,
}
impl TextLocation {
    pub fn page_number(&self) -> u8 {
        self.page_number
    }
    pub fn content_object(&self) -> u32 {
        self.content_object
    }
    pub fn font_object(&self) -> u32 {
        self.font_object
    }
    pub fn operator_offset(&self) -> usize {
        self.operator_offset
    }
    /// Coordinates use 100,000 integer units per PDF point; never monetary floats.
    pub fn position_fixed(&self) -> (i64, i64) {
        (self.x_fixed, self.y_fixed)
    }
}

/// The caller cannot supply the quantity. Only the verified selected bytes are read.
/// `VerifiedReviewedRevision` alone does NOT authenticate the caller's revision
/// approval, certificate chain, legal ownership, reservation or issuer authority.
pub fn extract_available_xau(
    revision: &VerifiedReviewedRevision<'_>,
) -> Result<AvailableXauStatement> {
    let bytes = revision.revision_bytes();
    let extracted = layout::extract(bytes)?;
    Ok(AvailableXauStatement {
        amount_mg: extracted.amount_mg,
        report_date: extracted.date,
        provenance: FieldProvenance {
            full_document_sha256: revision.full_document_sha256(),
            selected_revision_sha256: Sha256::digest(bytes).into(),
            signed_byte_ranges_sha256: revision.evidence().signed_digest,
            signer_fingerprint: revision.evidence().signer_fingerprint,
            selected_revision_bytes: bytes.len(),
            amount: extracted.amount_location,
            row: extracted.row_location,
            unit: extracted.unit_location,
            column: extracted.column_location,
            date: extracted.date_location,
        },
    })
}

#[cfg(test)]
mod tests;
