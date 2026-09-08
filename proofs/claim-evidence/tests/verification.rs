#![allow(clippy::unwrap_used)]

use ultratokenizer_claim_evidence::{
    request::{Request, RequestJson, MAX_REQUEST_BYTES},
    verify_claim, ClaimError, ClaimInput, CAPSULE_MARKER, MAX_WITNESS_BYTES,
};

const PDF: &[u8] = include_bytes!("../fixtures/gold-certificate.synthetic.pdf");
const REQUEST: &[u8] = include_bytes!("../fixtures/request.synthetic.json");
const METADATA: &str = include_str!("../fixtures/gold-certificate.synthetic.json");

fn metadata() -> serde_json::Value {
    serde_json::from_str(METADATA).unwrap()
}
fn signer() -> [u8; 32] {
    hex::decode(metadata()["signerFingerprint"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}
fn input<'a>(pdf: &'a [u8], request: &'a [u8]) -> ClaimInput<'a> {
    ClaimInput {
        approved_signer: signer(),
        request_json: request,
        pdf_bytes: pdf,
    }
}
fn request_change(field: &str, value: &str) -> Vec<u8> {
    let mut request: serde_json::Value = serde_json::from_slice(REQUEST).unwrap();
    request[field] = value.into();
    serde_json::to_vec(&request).unwrap()
}

#[test]
fn signed_claim_and_full_request_match_independent_viem_vectors() {
    let result = verify_claim(&input(PDF, REQUEST)).unwrap();
    let expected = metadata();
    assert_eq!(
        format!("0x{}", hex::encode(result.request_digest)),
        expected["requestDigest"]
    );
    assert_eq!(
        format!("0x{}", hex::encode(result.claim_usage_id)),
        expected["claimUsageId"]
    );
    assert_eq!(
        format!("0x{}", hex::encode(result.claim_commitment)),
        expected["claimCommitment"]
    );
    assert_eq!(
        format!("0x{}", hex::encode(result.public_values())),
        expected["publicValues"]
    );
    assert_eq!(result.public_values().len(), 224);
}

#[test]
fn every_authenticated_source_field_is_covered_by_the_signature() {
    let start = b"%PDF-1.7\n".len() + CAPSULE_MARKER.len();
    for offset in [0, 8, 40, 72, 104, 124, 156, 188] {
        let mut changed = PDF.to_vec();
        changed[start + offset * 2] = if changed[start + offset * 2] == b'0' {
            b'1'
        } else {
            b'0'
        };
        assert_eq!(
            verify_claim(&input(&changed, REQUEST)),
            Err(ClaimError::InvalidEvidence)
        );
    }
}

#[test]
fn holder_issuer_and_derived_identifiers_cannot_be_substituted() {
    for (field, value) in [
        ("recipient", format!("0x{}", "99".repeat(20))),
        ("issuerId", format!("0x{}", "99".repeat(32))),
        ("claimUsageId", format!("0x{}", "99".repeat(32))),
        ("claimCommitment", format!("0x{}", "99".repeat(32))),
    ] {
        assert_eq!(
            verify_claim(&input(PDF, &request_change(field, &value))),
            Err(ClaimError::ClaimMismatch)
        );
    }
}

#[test]
fn exact_capacity_and_expiry_boundaries_are_enforced() {
    assert!(verify_claim(&input(PDF, &request_change("amount", "10000"))).is_ok());
    assert_eq!(
        verify_claim(&input(PDF, &request_change("amount", "10001"))),
        Err(ClaimError::CapacityExceeded)
    );
    assert!(verify_claim(&input(PDF, &request_change("validUntil", "2000000000"))).is_ok());
    assert_eq!(
        verify_claim(&input(PDF, &request_change("validUntil", "2000000001"))),
        Err(ClaimError::ExpiryMismatch)
    );
}

#[test]
fn every_unconstrained_request_field_changes_the_public_digest() {
    let original = verify_claim(&input(PDF, REQUEST)).unwrap();
    for (field, value) in [
        ("requestId", format!("0x{}", "88".repeat(32))),
        ("chainId", "297".into()),
        ("gate", format!("0x{}", "88".repeat(20))),
        ("token", format!("0x{}", "88".repeat(20))),
        ("amount", "999".into()),
        ("reservationId", format!("0x{}", "88".repeat(32))),
        ("policyVersion", "2".into()),
        ("rightsVersion", "2".into()),
        ("nonce", "1".into()),
        ("validUntil", "1999998000".into()),
    ] {
        let result = verify_claim(&input(PDF, &request_change(field, &value))).unwrap();
        assert_ne!(result.request_digest, original.request_digest, "{field}");
        assert_eq!(result.claim_usage_id, original.claim_usage_id, "{field}");
    }
}

#[test]
fn request_json_order_does_not_change_the_digest() {
    let request: RequestJson = serde_json::from_slice(REQUEST).unwrap();
    let expected = Request::from_json(REQUEST).unwrap().digest();
    let reordered: serde_json::Value = serde_json::to_value(request).unwrap();
    assert_eq!(
        Request::from_json(&serde_json::to_vec(&reordered).unwrap())
            .unwrap()
            .digest(),
        expected
    );
}

#[test]
fn malformed_literals_integers_identifiers_and_extra_fields_fail_closed() {
    for (field, value) in [
        ("schemaVersion", "2"),
        ("action", "TRANSFER"),
        ("unit", "XAU_GRAM"),
        ("amount", "0"),
        ("amount", "1.1"),
        ("amount", "1e3"),
        ("amount", "01"),
        ("amount", "-1"),
        ("amount", " 1"),
        (
            "amount",
            "115792089237316195423570985008687907853269984665640564039457584007913129639936",
        ),
        ("policyVersion", "18446744073709551616"),
        ("validUntil", "0"),
        ("recipient", "0x0000000000000000000000000000000000000000"),
        ("requestId", "0x00"),
        ("unexpected", "ignored"),
    ] {
        assert!(
            matches!(
                Request::from_json(&request_change(field, value)),
                Err(ClaimError::InvalidRequest)
            ),
            "{field}"
        );
    }
    let duplicate =
        String::from_utf8(REQUEST.to_vec())
            .unwrap()
            .replacen('{', "{\"amount\":\"1000\",", 1);
    assert!(Request::from_json(duplicate.as_bytes()).is_err());
    assert!(matches!(
        Request::from_json(&vec![b' '; MAX_REQUEST_BYTES + 1]),
        Err(ClaimError::InputSize)
    ));
}

#[test]
fn mixed_case_address_checksums_are_verified() {
    assert!(Request::from_json(&request_change(
        "gate",
        "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    ))
    .is_err());
    assert!(Request::from_json(&request_change(
        "gate",
        "0x52908400098527886E0F7030069857D2E4169EE7"
    ))
    .is_ok());
    assert!(Request::from_json(&request_change(
        "gate",
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
    ))
    .is_ok());
    assert!(Request::from_json(&request_change(
        "gate",
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"
    ))
    .is_err());
}

#[test]
fn wrong_signers_and_signature_only_documents_are_rejected() {
    let mut wrong = input(PDF, REQUEST);
    wrong.approved_signer = [0x99; 32];
    assert_eq!(verify_claim(&wrong), Err(ClaimError::InvalidEvidence));
    let other = include_bytes!("../../pdf-evidence/fixtures/statement.synthetic.pdf");
    let metadata: serde_json::Value = serde_json::from_str(include_str!(
        "../../pdf-evidence/fixtures/statement.synthetic.json"
    ))
    .unwrap();
    let signer = hex::decode(metadata["signerFingerprint"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        verify_claim(&ClaimInput {
            approved_signer: signer,
            request_json: REQUEST,
            pdf_bytes: other
        }),
        Err(ClaimError::InvalidCapsule)
    );
}

#[test]
fn witness_decoding_checks_sizes_before_slicing_and_rejects_trailing_data() {
    let valid = input(PDF, REQUEST).encode().unwrap();
    let decoded = ClaimInput::decode(&valid).unwrap();
    assert_eq!(verify_claim(&decoded), verify_claim(&input(PDF, REQUEST)));
    for length in [0, 7, 47, 48, valid.len() - 1] {
        assert!(ClaimInput::decode(&valid[..length]).is_err());
    }
    let mut oversized = valid.clone();
    oversized[40..44].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(matches!(
        ClaimInput::decode(&oversized),
        Err(ClaimError::InputSize)
    ));
    let mut oversized = valid.clone();
    oversized[44..48].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(matches!(
        ClaimInput::decode(&oversized),
        Err(ClaimError::InputSize)
    ));
    let mut trailing = valid;
    trailing.push(0);
    assert!(matches!(
        ClaimInput::decode(&trailing),
        Err(ClaimError::InvalidWitness)
    ));
    assert!(matches!(
        ClaimInput::decode(&vec![0; MAX_WITNESS_BYTES + 1]),
        Err(ClaimError::InputSize)
    ));
}
