//! Separate the network's u32-limb program identity from the EVM BN254 key.

use crate::disclosure::PublicDisclosure;
use sp1_sdk::{
    network::{NetworkClient, B256},
    HashableKey, SP1VerifyingKey,
};
use ultratokenizer_network_request_schema::{EXPECTED_NETWORK_VK_HASH, EXPECTED_PROGRAM_VKEY};

pub fn program_hash() -> Result<B256, &'static str> {
    EXPECTED_NETWORK_VK_HASH
        .parse()
        .map_err(|_| "Pinned network program hash is malformed.")
}

pub fn verify_key(key: &SP1VerifyingKey) -> Result<B256, &'static str> {
    let network =
        NetworkClient::get_vk_hash(key).map_err(|_| "Network program identity failed.")?;
    if key.bytes32() != EXPECTED_PROGRAM_VKEY || network != program_hash()? {
        return Err("ELF does not match both the EVM and network program identities.");
    }
    Ok(network)
}

pub fn require_current(value: Option<&str>) -> Result<(), &'static str> {
    if value != Some(EXPECTED_NETWORK_VK_HASH) {
        return Err("Legacy network identity is read-only; prepare a separately reviewed request.");
    }
    Ok(())
}

pub fn operation_id(
    preparation_id: &str,
    requester: &str,
    disclosure: Option<&PublicDisclosure>,
    network_vk_hash: Option<&str>,
) -> Result<String, &'static str> {
    let legacy = crate::disclosure::operation_id(preparation_id, requester, disclosure)?;
    let Some(network_vk_hash) = network_vk_hash else {
        return Ok(legacy);
    };
    require_current(Some(network_vk_hash))?;
    let bytes = serde_json::to_vec(&(
        "ultratokenizer-sp1-stage-network-identity-v2",
        legacy,
        network_vk_hash,
    ))
    .map_err(|_| "Unable to identify network staging.")?;
    Ok(format!("0x{}", crate::sha256_hex(&bytes)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn sdk_network_pin_and_evm_pin_encode_the_same_eight_field_limbs_differently() {
        let bytes = program_hash().unwrap().to_vec();
        let mut packed = [0u8; 32];
        for chunk in bytes.chunks_exact(4) {
            let word = u32::from_be_bytes(chunk.try_into().unwrap());
            assert!(word < 0x7f000001);
            for bit in (0..31).rev() {
                let mut carry = ((word >> bit) & 1) as u8;
                for byte in packed.iter_mut().rev() {
                    let next = *byte >> 7;
                    *byte = (*byte << 1) | carry;
                    carry = next;
                }
                assert_eq!(carry, 0);
            }
        }
        assert_eq!(format!("0x{}", hex::encode(packed)), EXPECTED_PROGRAM_VKEY);
        assert_ne!(EXPECTED_NETWORK_VK_HASH, EXPECTED_PROGRAM_VKEY);
        assert!(require_current(None).is_err());
        assert!(require_current(Some(EXPECTED_PROGRAM_VKEY)).is_err());
    }
}
