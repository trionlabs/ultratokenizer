#![allow(clippy::unwrap_used)]

use sha2::{Digest, Sha256};
use ultratokenizer_pdf_evidence::reviewed_revision::{verify_reviewed_revision, ApprovedRevision};
use ultratokenizer_pdf_evidence::{verify_pdf, EvidenceError, MAX_PDF_BYTES};

const PDF: &[u8] = include_bytes!("../fixtures/statement.synthetic.pdf");
const METADATA: &str = include_str!("../fixtures/statement.synthetic.json");

fn expected(field: &str) -> Vec<u8> {
    let metadata: serde_json::Value = serde_json::from_str(METADATA).unwrap();
    hex::decode(metadata[field].as_str().unwrap()).unwrap()
}

fn signer() -> [u8; 32] {
    expected("signerFingerprint").try_into().unwrap()
}

fn replace_once(pdf: &[u8], before: &[u8], after: &[u8]) -> Vec<u8> {
    assert_eq!(before.len(), after.len());
    let index = pdf
        .windows(before.len())
        .position(|bytes| bytes == before)
        .unwrap();
    let mut result = pdf.to_vec();
    result[index..index + before.len()].copy_from_slice(after);
    result
}

fn replace_cms(cms: &[u8]) -> Vec<u8> {
    let marker = b"/Contents <";
    let start = PDF.windows(marker.len()).position(|b| b == marker).unwrap() + marker.len();
    let end = start + PDF[start..].iter().position(|b| *b == b'>').unwrap();
    let encoded = hex::encode(cms);
    assert!(encoded.len() <= end - start);
    let mut result = PDF.to_vec();
    result[start..end].fill(b'0');
    result[start..start + encoded.len()].copy_from_slice(encoded.as_bytes());
    result
}

fn der(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut result = vec![tag];
    if body.len() < 128 {
        result.push(body.len() as u8);
    } else {
        assert!(body.len() <= u16::MAX as usize);
        if body.len() <= u8::MAX as usize {
            result.extend_from_slice(&[0x81, body.len() as u8]);
        } else {
            result.push(0x82);
            result.extend_from_slice(&(body.len() as u16).to_be_bytes());
        }
    }
    result.extend_from_slice(body);
    result
}

fn der_size(bytes: &[u8]) -> (usize, usize) {
    if bytes[1] < 128 {
        (2, usize::from(bytes[1]))
    } else {
        let count = usize::from(bytes[1] & 0x7f);
        let size = bytes[2..2 + count]
            .iter()
            .fold(0, |value, byte| value * 256 + usize::from(*byte));
        (2 + count, size)
    }
}

// Re-encode one node in a known-valid synthetic CMS without changing signed PDF bytes.
fn rewrite_der(bytes: &[u8], path: &[usize], rewrite: impl Fn(&[u8]) -> Vec<u8> + Copy) -> Vec<u8> {
    let (header, size) = der_size(bytes);
    let body = &bytes[header..header + size];
    if path.is_empty() {
        return der(bytes[0], &rewrite(body));
    }
    let mut children = Vec::new();
    let mut offset = 0;
    let mut index = 0;
    while offset < body.len() {
        let (header, size) = der_size(&body[offset..]);
        let child = &body[offset..offset + header + size];
        children.extend_from_slice(&if index == path[0] {
            rewrite_der(child, &path[1..], rewrite)
        } else {
            child.to_vec()
        });
        offset += header + size;
        index += 1;
    }
    assert!(path[0] < index);
    der(bytes[0], &children)
}

#[test]
fn rejects_multiple_cms_signers_even_if_the_first_signature_verifies() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let multiple = rewrite_der(&cms, &[1, 0, 4], |body| [body, body].concat());
    let pdf = replace_cms(&multiple);
    assert!(
        signature_validator::verify_pdf_signature(&pdf)
            .unwrap()
            .is_valid
    );
    assert_eq!(verify_pdf(&pdf, &signer()), Err(EvidenceError::InvalidCms));
}

#[test]
fn rejects_truncated_signer_info_without_panicking() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let malformed = rewrite_der(&cms, &[1, 0, 4, 0], |_| der(0x02, &[1]));
    assert_eq!(
        verify_pdf(&replace_cms(&malformed), &signer()),
        Err(EvidenceError::InvalidCms)
    );
}

#[test]
fn rejects_duplicate_signed_attributes_and_empty_digest_values() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let duplicate = rewrite_der(&cms, &[1, 0, 4, 0, 3], |body| [body, body].concat());
    assert_eq!(
        verify_pdf(&replace_cms(&duplicate), &signer()),
        Err(EvidenceError::InvalidCms)
    );
    let empty = rewrite_der(&cms, &[1, 0, 4, 0, 2], |_| Vec::new());
    assert_eq!(
        verify_pdf(&replace_cms(&empty), &signer()),
        Err(EvidenceError::InvalidCms)
    );
}

#[test]
fn rejects_nonzero_signature_padding() {
    let (mut cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    cms.push(0xff);
    let pdf = replace_cms(&cms);
    assert!(
        signature_validator::verify_pdf_signature(&pdf)
            .unwrap()
            .is_valid
    );
    assert_eq!(verify_pdf(&pdf, &signer()), Err(EvidenceError::InvalidCms));
}

#[test]
fn rejects_indefinite_lengths_and_excessive_der_nesting() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let (header, _) = der_size(&cms);
    let indefinite = [&[0x30, 0x80][..], &cms[header..], &[0, 0]].concat();
    assert_eq!(
        verify_pdf(&replace_cms(&indefinite), &signer()),
        Err(EvidenceError::InvalidCms)
    );
    let mut nested = der(0x02, &[1]);
    for _ in 0..32 {
        nested = der(0x30, &nested);
    }
    assert_eq!(
        verify_pdf(&replace_cms(&nested), &signer()),
        Err(EvidenceError::InvalidCms)
    );
}

#[test]
fn rejects_empty_cms_sequences_without_panicking() {
    assert_eq!(
        verify_pdf(&replace_cms(&[0x30, 0x00]), &signer()),
        Err(EvidenceError::InvalidCms)
    );
}

#[test]
fn rejects_overflowing_cms_lengths_without_panicking() {
    assert_eq!(
        verify_pdf(
            &replace_cms(&[0x30, 0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            &signer()
        ),
        Err(EvidenceError::InvalidCms)
    );
}

#[test]
fn verifies_a_real_openssl_signature_and_matches_independent_public_values() {
    let result = verify_pdf(PDF, &signer()).unwrap();
    assert_eq!(result.profile_version, 1);
    assert_eq!(result.signed_digest.as_slice(), expected("signedDigest"));
    assert_eq!(result.public_values().as_slice(), expected("publicValues"));
}

#[test]
fn rejects_a_different_or_empty_signer_policy() {
    assert_eq!(
        verify_pdf(PDF, &[0x55; 32]),
        Err(EvidenceError::SignerNotAllowed)
    );
    assert_eq!(
        verify_pdf(PDF, &[0; 32]),
        Err(EvidenceError::SignerNotAllowed)
    );
}

#[test]
fn rejects_a_changed_balance_in_the_signed_content() {
    let forged = replace_once(PDF, b"Balance: 10000", b"Balance: 90000");
    assert_eq!(
        verify_pdf(&forged, &signer()),
        Err(EvidenceError::InvalidSignature)
    );
}

#[test]
fn rejects_appended_content_even_when_the_original_signature_still_verifies() {
    let mut forged = PDF.to_vec();
    forged.extend_from_slice(b"\n9 0 obj << /Injected (Balance: 90000) >> endobj\n%%EOF\n");
    assert!(
        signature_validator::verify_pdf_signature(&forged)
            .unwrap()
            .is_valid
    );
    assert_eq!(
        verify_pdf(&forged, &signer()),
        Err(EvidenceError::UnsignedRevision)
    );
}

#[test]
fn rejects_ambiguous_signature_selection() {
    let forged = replace_once(PDF, b"SyntheticSignature", b"/ByteRange padding");
    assert_eq!(
        verify_pdf(&forged, &signer()),
        Err(EvidenceError::AmbiguousSignature)
    );
}

#[test]
fn rejects_invalid_numbers_and_uncovered_prefixes() {
    for replacement in [b"+000000000", b"0000000001", b"-000000001", b"invalid000"] {
        let mut pattern = b"/ByteRange [".to_vec();
        pattern.extend_from_slice(b"0000000000");
        let mut changed = b"/ByteRange [".to_vec();
        changed.extend_from_slice(replacement);
        let forged = replace_once(PDF, &pattern, &changed);
        assert_eq!(
            verify_pdf(&forged, &signer()),
            Err(EvidenceError::InvalidByteRange)
        );
    }
}

#[test]
fn rejects_non_signature_data_in_the_unsigned_gap() {
    let marker = b"/Contents <";
    let position = PDF
        .windows(marker.len())
        .position(|bytes| bytes == marker)
        .unwrap()
        + marker.len();
    let mut forged = PDF.to_vec();
    forged[position..position + 6].copy_from_slice(b"/Other");
    assert_eq!(
        verify_pdf(&forged, &signer()),
        Err(EvidenceError::InvalidSignatureGap)
    );
}

#[test]
fn rejects_a_corrupted_signature_container() {
    let marker = b"/Contents <";
    let position = PDF
        .windows(marker.len())
        .position(|bytes| bytes == marker)
        .unwrap()
        + marker.len();
    let mut forged = PDF.to_vec();
    forged[position..position + 8].copy_from_slice(b"00000000");
    assert_eq!(
        verify_pdf(&forged, &signer()),
        Err(EvidenceError::InvalidCms)
    );
}

#[test]
fn rejects_a_corrupted_rsa_signature_with_intact_content_and_cms_structure() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let parameters = signature_validator::pkcs7_parser::parse_signed_data(&cms).unwrap();
    let signature_hex = hex::encode(parameters.signature);
    let position = PDF
        .windows(signature_hex.len())
        .position(|bytes| bytes == signature_hex.as_bytes())
        .unwrap();
    let mut forged = PDF.to_vec();
    forged[position] = if forged[position] == b'0' { b'1' } else { b'0' };
    assert_eq!(
        verify_pdf(&forged, &signer()),
        Err(EvidenceError::InvalidSignature)
    );
}

#[test]
fn rejects_extra_range_values_junk_overlaps_and_integer_overflow() {
    for ranges in [
        "0 10 20 30 40",
        "0 10 junk 20 30",
        "0 100 20 30",
        "0 99999999999999999999999999999999999999 20 30",
        "0 10 18446744073709551615 18446744073709551615",
        "0 10 20",
    ] {
        let pdf = format!("%PDF-1.7\n/ByteRange [{ranges}] /Contents <00>\n%%EOF\n");
        assert_eq!(
            verify_pdf(pdf.as_bytes(), &signer()),
            Err(EvidenceError::InvalidByteRange)
        );
    }
}

#[test]
fn rejects_unsupported_and_oversized_inputs_without_echoing_content() {
    assert_eq!(verify_pdf(&[], &signer()), Err(EvidenceError::InputSize));
    assert_eq!(
        verify_pdf(&vec![0; MAX_PDF_BYTES + 1], &signer()),
        Err(EvidenceError::InputSize)
    );
    let error = verify_pdf(b"confidential document contents", &signer()).unwrap_err();
    assert_eq!(error, EvidenceError::UnsupportedPdf);
    assert!(!error.to_string().contains("confidential"));
}

fn approval(pdf: &[u8], signed_revision_bytes: usize) -> ApprovedRevision {
    ApprovedRevision {
        full_document_sha256: Sha256::digest(pdf).into(),
        signed_revision_bytes,
        signer_fingerprint: signer(),
    }
}

#[test]
fn reviewed_revision_requires_exact_complete_file_approval_and_returns_only_signed_prefix() {
    let mut complete = PDF.to_vec();
    complete.extend_from_slice(b"\n9 0 obj << /Later (Untrusted metadata) >> endobj\n%%EOF\n");
    // The approval in this unit test stands for a separately authenticated
    // institutional policy. Computing one's own hash does not confer authority.
    let policy = approval(&complete, PDF.len());
    let result = verify_reviewed_revision(&complete, &policy).unwrap();
    assert_eq!(result.revision_bytes(), PDF);
    assert_eq!(result.full_document_sha256(), policy.full_document_sha256);
    assert_eq!(result.evidence().profile_version, 2);
    assert_eq!(
        result.evidence().signed_digest.as_slice(),
        expected("signedDigest")
    );
    *complete.last_mut().unwrap() = b' ';
    assert!(matches!(
        verify_reviewed_revision(&complete, &policy),
        Err(EvidenceError::RevisionNotApproved)
    ));
    assert!(matches!(
        verify_reviewed_revision(PDF, &approval(PDF, PDF.len() - 1)),
        Err(EvidenceError::InvalidByteRange)
    ));
    for length in [0, PDF.len() + 1] {
        assert!(matches!(
            verify_reviewed_revision(PDF, &approval(PDF, length)),
            Err(EvidenceError::RevisionNotApproved)
        ));
    }
}

#[test]
fn reviewed_cades_allows_opaque_timestamp_metadata_without_trusting_it() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    fn unsigned_timestamp() -> Vec<u8> {
        let id = der(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 9, 16, 2, 14]);
        // Deliberately not a valid timestamp: no timestamp guarantee is made.
        let opaque = der(0x31, &der(0x30, &der(0x02, &[1])));
        der(0xa1, &der(0x30, &[id, opaque].concat()))
    }
    let with_timestamp = rewrite_der(&cms, &[1, 0, 4, 0], |body| {
        [body, &unsigned_timestamp()].concat()
    });
    let pdf = replace_cms(&with_timestamp);
    let policy = approval(&pdf, pdf.len());
    assert!(verify_reviewed_revision(&pdf, &policy).is_ok());
    assert_eq!(verify_pdf(&pdf, &signer()), Err(EvidenceError::InvalidCms));

    let with_duplicate = rewrite_der(&cms, &[1, 0, 4, 0], |body| {
        [body, &unsigned_timestamp(), &unsigned_timestamp()].concat()
    });
    let pdf = replace_cms(&with_duplicate);
    assert!(matches!(
        verify_reviewed_revision(&pdf, &approval(&pdf, pdf.len())),
        Err(EvidenceError::InvalidCms)
    ));
}

#[test]
fn reviewed_cades_distinguishes_ca_signature_from_pinned_rsa_document_key() {
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let modified = rewrite_der(&cms, &[1, 0, 3, 0, 0, 2], |_| {
        der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 4, 3, 3])
    });
    let modified = rewrite_der(&modified, &[1, 0, 3, 0, 1], |_| {
        der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 4, 3, 3])
    });
    // Changing this synthetic certificate invalidates its issuer signature.
    // The document signature remains valid under the same independently pinned
    // RSA leaf. This primitive deliberately does not validate a PKI chain.
    let pdf = replace_cms(&modified);
    assert!(verify_reviewed_revision(&pdf, &approval(&pdf, pdf.len())).is_ok());
    assert_eq!(verify_pdf(&pdf, &signer()), Err(EvidenceError::InvalidCms));
    let mut wrong = approval(&pdf, pdf.len());
    wrong.signer_fingerprint = [0x55; 32];
    assert!(matches!(
        verify_reviewed_revision(&pdf, &wrong),
        Err(EvidenceError::SignerNotAllowed)
    ));
    let modified = rewrite_der(&modified, &[1, 0, 4, 0, 3], |body| [body, body].concat());
    let pdf = replace_cms(&modified);
    assert!(matches!(
        verify_reviewed_revision(&pdf, &approval(&pdf, pdf.len())),
        Err(EvidenceError::InvalidCms)
    ));
}

#[test]
fn reviewed_cades_keeps_signature_checks_and_unsigned_metadata_bounds() {
    let forged = replace_once(PDF, b"Balance: 10000", b"Balance: 90000");
    assert!(matches!(
        verify_reviewed_revision(&forged, &approval(&forged, forged.len())),
        Err(EvidenceError::InvalidSignature)
    ));
    let (cms, _) = signature_validator::signed_bytes_extractor::get_signature_der(PDF).unwrap();
    let nested = rewrite_der(&cms, &[1, 0, 4, 0], |body| {
        let mut opaque = der(0x02, &[1]);
        for _ in 0..32 {
            opaque = der(0x30, &opaque);
        }
        let id = der(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 9, 16, 2, 14]);
        [
            body,
            &der(0xa1, &der(0x30, &[id, der(0x31, &opaque)].concat())),
        ]
        .concat()
    });
    let pdf = replace_cms(&nested);
    assert!(matches!(
        verify_reviewed_revision(&pdf, &approval(&pdf, pdf.len())),
        Err(EvidenceError::InvalidCms)
    ));
    let unknown = rewrite_der(&cms, &[1, 0, 4, 0], |body| {
        let id = der(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 9, 16, 2, 15]);
        let value = der(0x31, &der(0x30, &der(0x02, &[1])));
        [body, &der(0xa1, &der(0x30, &[id, value].concat()))].concat()
    });
    let pdf = replace_cms(&unknown);
    assert!(matches!(
        verify_reviewed_revision(&pdf, &approval(&pdf, pdf.len())),
        Err(EvidenceError::InvalidCms)
    ));
}
