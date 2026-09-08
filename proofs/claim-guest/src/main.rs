#![no_main]

use ultratokenizer_claim_evidence::{verify_claim, ClaimInput, MAX_WITNESS_BYTES};

sp1_zkvm::entrypoint!(main);

pub fn main() {
    // Check the actual next hint length before the SDK allocates its input buffer.
    let length = sp1_zkvm::syscalls::syscall_hint_len();
    assert!(
        (48..=MAX_WITNESS_BYTES).contains(&length),
        "Claim witness rejected."
    );
    let bytes = sp1_zkvm::io::read_vec();
    let input = ClaimInput::decode(&bytes).unwrap_or_else(|_| panic!("Claim witness rejected."));
    let claim = verify_claim(&input).unwrap_or_else(|_| panic!("Claim evidence rejected."));
    sp1_zkvm::io::commit_slice(&claim.public_values());
}
