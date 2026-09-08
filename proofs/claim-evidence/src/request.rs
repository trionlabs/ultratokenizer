//! Independent implementation of packages/domain's canonical EIP-712 request.

use crate::{hash, ClaimError, Result};
use serde::{Deserialize, Serialize};

pub const UNIT: &str = "XAU_MILLIGRAM";
pub const MAX_REQUEST_BYTES: usize = 4096;
pub type Word = [u8; 32];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestJson {
    pub schema_version: String,
    pub action: String,
    pub request_id: String,
    pub chain_id: String,
    pub gate: String,
    pub token: String,
    pub recipient: String,
    pub amount: String,
    pub unit: String,
    pub issuer_id: String,
    pub reservation_id: String,
    pub claim_commitment: String,
    pub claim_usage_id: String,
    pub policy_version: String,
    pub rights_version: String,
    pub nonce: String,
    pub valid_until: String,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub request_id: Word,
    pub chain_id: Word,
    pub gate: Word,
    pub token: Word,
    pub recipient: Word,
    pub amount: Word,
    pub issuer_id: Word,
    pub reservation_id: Word,
    pub claim_commitment: Word,
    pub claim_usage_id: Word,
    pub policy_version: Word,
    pub rights_version: Word,
    pub nonce: Word,
    pub valid_until: u64,
}

pub fn word_u64(value: u64) -> Word {
    let mut word = [0; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

pub fn decimal(value: &str, bits: u16, allow_zero: bool) -> Result<Word> {
    let limit = if bits == 64 { 20 } else { 78 };
    if value.is_empty()
        || value.len() > limit
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(ClaimError::InvalidRequest);
    }
    let mut word = [0u8; 32];
    for digit in value.bytes() {
        let mut carry = u16::from(digit - b'0');
        for byte in word.iter_mut().rev() {
            let product = u16::from(*byte) * 10 + carry;
            *byte = product as u8;
            carry = product >> 8;
        }
        if carry != 0 {
            return Err(ClaimError::InvalidRequest);
        }
    }
    if (!allow_zero && word == [0; 32]) || (bits == 64 && word[..24] != [0; 24]) {
        return Err(ClaimError::InvalidRequest);
    }
    Ok(word)
}

fn identifier(value: &str) -> Result<Word> {
    let mut word = [0; 32];
    let raw = value.strip_prefix("0x").ok_or(ClaimError::InvalidRequest)?;
    hex::decode_to_slice(raw, &mut word).map_err(|_| ClaimError::InvalidRequest)?;
    if word == [0; 32] {
        return Err(ClaimError::InvalidRequest);
    }
    Ok(word)
}

fn address(value: &str) -> Result<Word> {
    let raw = value.strip_prefix("0x").ok_or(ClaimError::InvalidRequest)?;
    let mut word = [0; 32];
    hex::decode_to_slice(raw, &mut word[12..]).map_err(|_| ClaimError::InvalidRequest)?;
    if word == [0; 32] {
        return Err(ClaimError::InvalidRequest);
    }
    let lower = raw.to_ascii_lowercase();
    if raw != lower {
        let checksum = hex::encode(hash(lower.as_bytes()));
        for (letter, nibble) in raw.bytes().zip(checksum.bytes()) {
            if letter.is_ascii_alphabetic() {
                let uppercase = nibble >= b'8';
                if letter.is_ascii_uppercase() != uppercase {
                    return Err(ClaimError::InvalidRequest);
                }
            }
        }
    }
    Ok(word)
}

impl Request {
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(ClaimError::InputSize);
        }
        let value: RequestJson =
            serde_json::from_slice(bytes).map_err(|_| ClaimError::InvalidRequest)?;
        if value.schema_version != "1" || value.action != "ISSUE" || value.unit != UNIT {
            return Err(ClaimError::InvalidRequest);
        }
        let expiry = decimal(&value.valid_until, 64, false)?;
        Ok(Self {
            request_id: identifier(&value.request_id)?,
            chain_id: decimal(&value.chain_id, 256, false)?,
            gate: address(&value.gate)?,
            token: address(&value.token)?,
            recipient: address(&value.recipient)?,
            amount: decimal(&value.amount, 256, false)?,
            issuer_id: identifier(&value.issuer_id)?,
            reservation_id: identifier(&value.reservation_id)?,
            claim_commitment: identifier(&value.claim_commitment)?,
            claim_usage_id: identifier(&value.claim_usage_id)?,
            policy_version: decimal(&value.policy_version, 64, false)?,
            rights_version: decimal(&value.rights_version, 64, false)?,
            nonce: decimal(&value.nonce, 256, true)?,
            valid_until: u64::from_be_bytes(
                expiry[24..]
                    .try_into()
                    .map_err(|_| ClaimError::InvalidRequest)?,
            ),
        })
    }

    pub fn digest(&self) -> Word {
        let domain = hash_words(&[
            hash(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            hash(b"Ultratokenizer"), hash(b"1"), self.chain_id, self.gate,
        ]);
        let message = hash_words(&[
            hash(b"IssuanceRequest(uint8 schemaVersion,string action,bytes32 requestId,address token,address recipient,uint256 amount,string unit,bytes32 issuerId,bytes32 reservationId,bytes32 claimCommitment,bytes32 claimUsageId,uint64 policyVersion,uint64 rightsVersion,uint256 nonce,uint64 validUntil)"),
            word_u64(1), hash(b"ISSUE"), self.request_id, self.token, self.recipient,
            self.amount, hash(UNIT.as_bytes()), self.issuer_id, self.reservation_id,
            self.claim_commitment, self.claim_usage_id, self.policy_version,
            self.rights_version, self.nonce, word_u64(self.valid_until),
        ]);
        let mut encoded = [0u8; 66];
        encoded[..2].copy_from_slice(&[0x19, 0x01]);
        encoded[2..34].copy_from_slice(&domain);
        encoded[34..].copy_from_slice(&message);
        hash(&encoded)
    }
}

pub fn hash_words(words: &[Word]) -> Word {
    let bytes: Vec<u8> = words.iter().flatten().copied().collect();
    hash(&bytes)
}
