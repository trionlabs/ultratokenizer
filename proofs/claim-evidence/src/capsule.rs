//! The synthetic profile authenticates this exact header capsule, never PDF text.

use crate::{
    claim_identity::claim_usage_id,
    hash,
    request::{hash_words, word_u64, Word, UNIT},
    ClaimError, Result,
};

pub const CAPSULE_MARKER: &[u8] = b"%ULTRATOKENIZER-SYNTHETIC-GOLD-V1 ";
pub const CAPSULE_BYTES: usize = 196;

pub(crate) struct Capsule {
    pub source_id: Word,
    pub claim_id: Word,
    pub issuer_id: Word,
    pub holder: Word,
    pub capacity: Word,
    pub valid_until: u64,
}

impl Capsule {
    pub fn parse(pdf: &[u8]) -> Result<Self> {
        let after_header = pdf
            .strip_prefix(b"%PDF-1.7\n")
            .ok_or(ClaimError::InvalidCapsule)?;
        if pdf
            .windows(CAPSULE_MARKER.len())
            .filter(|window| *window == CAPSULE_MARKER)
            .count()
            != 1
        {
            return Err(ClaimError::InvalidCapsule);
        }
        let body = after_header
            .strip_prefix(CAPSULE_MARKER)
            .ok_or(ClaimError::InvalidCapsule)?;
        let encoded = body
            .get(..CAPSULE_BYTES * 2)
            .ok_or(ClaimError::InvalidCapsule)?;
        if body.get(CAPSULE_BYTES * 2) != Some(&b'\n')
            || !encoded
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err(ClaimError::InvalidCapsule);
        }
        let mut bytes = [0; CAPSULE_BYTES];
        hex::decode_to_slice(encoded, &mut bytes).map_err(|_| ClaimError::InvalidCapsule)?;
        if &bytes[..8] != b"UTSG0001" {
            return Err(ClaimError::InvalidCapsule);
        }
        let take_word = |start: usize| -> Result<Word> {
            bytes[start..start + 32]
                .try_into()
                .map_err(|_| ClaimError::InvalidCapsule)
        };
        let mut holder = [0; 32];
        holder[12..].copy_from_slice(&bytes[104..124]);
        let capsule = Self {
            source_id: take_word(8)?,
            claim_id: take_word(40)?,
            issuer_id: take_word(72)?,
            holder,
            capacity: take_word(124)?,
            valid_until: u64::from_be_bytes(
                bytes[188..196]
                    .try_into()
                    .map_err(|_| ClaimError::InvalidCapsule)?,
            ),
        };
        if [
            capsule.source_id,
            capsule.claim_id,
            capsule.issuer_id,
            capsule.holder,
            capsule.capacity,
        ]
        .contains(&[0; 32])
            || capsule.valid_until == 0
            || take_word(156)? != hash(UNIT.as_bytes())
        {
            return Err(ClaimError::InvalidCapsule);
        }
        Ok(capsule)
    }

    pub fn usage_id(&self) -> Word {
        claim_usage_id(self.source_id, self.claim_id)
    }

    pub fn commitment(&self) -> Word {
        hash_words(&[
            hash(b"UltratokenizerSyntheticGoldClaimV1(bytes32 sourceId,bytes32 claimId,bytes32 issuerId,address holder,uint256 capacityMilligrams,string unit,uint64 validUntil)"),
            self.source_id, self.claim_id, self.issuer_id, self.holder, self.capacity,
            hash(UNIT.as_bytes()), word_u64(self.valid_until),
        ])
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    const PDF: &[u8] = include_bytes!("../fixtures/gold-certificate.synthetic.pdf");

    #[test]
    fn identity_is_stable_across_issuer_holder_capacity_and_expiry_changes() {
        let mut claim = Capsule::parse(PDF).unwrap();
        let usage = claim.usage_id();
        let commitment = claim.commitment();
        claim.issuer_id = [0x66; 32];
        claim.holder = [0x77; 32];
        claim.capacity = word_u64(5000);
        claim.valid_until += 1;
        assert_eq!(claim.usage_id(), usage);
        assert_ne!(claim.commitment(), commitment);
        claim.claim_id = [0x78; 32];
        assert_ne!(claim.usage_id(), usage);
    }

    #[test]
    fn capsule_decoder_rejects_unknown_units_zero_identities_and_versions() {
        let start = b"%PDF-1.7\n".len() + CAPSULE_MARKER.len();
        for (offset, count) in [
            (0, 8),
            (8, 32),
            (40, 32),
            (72, 32),
            (104, 20),
            (124, 32),
            (156, 32),
            (188, 8),
        ] {
            let mut malformed = PDF.to_vec();
            malformed[start + offset * 2..start + (offset + count) * 2].fill(b'0');
            assert!(matches!(
                Capsule::parse(&malformed),
                Err(ClaimError::InvalidCapsule)
            ));
        }
        let mut duplicate = PDF.to_vec();
        duplicate.extend_from_slice(CAPSULE_MARKER);
        assert!(matches!(
            Capsule::parse(&duplicate),
            Err(ClaimError::InvalidCapsule)
        ));
    }
}
