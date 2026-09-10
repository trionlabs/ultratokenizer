//! Canonical claim usage identity, identical to packages/domain/claim-identity.ts.

use crate::{hash, request::hash_words, request::Word};

/// EIP-712-style type string; its hash is the domain separator for this
/// derivation, keeping it distinct from request digests and claim commitments.
pub const CLAIM_USAGE_TYPE: &[u8] = b"UltratokenizerClaimUsageV2(bytes32 sourceId,bytes32 claimId)";

/// Stable, privacy-preserving claim usage identifier:
///
///   keccak256(abi.encode(typeHash, sourceId, claimId))
///
/// It is a one-way hash of authenticated capsule identifiers, never a raw
/// document or account identifier, and it does not depend on the mint issuer,
/// holder wallet, signing key, salt or policy version. Zero-word rejection is
/// the caller's boundary, not part of this hash.
pub fn claim_usage_id(source_id: Word, claim_id: Word) -> Word {
    // Zero-word rejection is enforced by callers (capsule parse, CLI decode);
    // assert the invariant here so a direct misuse fails loudly in tests.
    debug_assert!(
        source_id != [0; 32] && claim_id != [0; 32],
        "claim identity words must be nonzero"
    );
    hash_words(&[hash(CLAIM_USAGE_TYPE), source_id, claim_id])
}
