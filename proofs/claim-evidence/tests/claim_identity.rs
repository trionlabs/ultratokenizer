//! Fixed vectors for the canonical claim usage identity, shared with TypeScript.

use ultratokenizer_claim_evidence::{claim_usage_id, CLAIM_USAGE_TYPE};

const fn word(byte: u8) -> [u8; 32] {
    [byte; 32]
}

#[test]
fn matches_pinned_synthetic_vector() {
    let source_id = word(0xa1);
    let claim_id = word(0xb2);
    let usage = claim_usage_id(source_id, claim_id);
    assert_eq!(
        format!("0x{}", hex::encode(usage)),
        "0xc8a8c0da5c7e9b2370346176465191740d40138c03945a79cebbd21e2ff7ddf8"
    );
}

#[test]
fn depends_only_on_source_and_claim() {
    let source_id = word(0x11);
    let claim_id = word(0x33);
    let usage = claim_usage_id(source_id, claim_id);
    assert_eq!(claim_usage_id(source_id, claim_id), usage);
    assert_ne!(claim_usage_id(word(0x12), claim_id), usage);
    assert_ne!(claim_usage_id(source_id, word(0x34)), usage);
}

#[test]
fn type_string_is_the_domain_separator() {
    assert_eq!(
        CLAIM_USAGE_TYPE,
        b"UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)".as_slice()
    );
}
