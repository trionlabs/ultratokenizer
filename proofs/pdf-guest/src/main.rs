#![no_main]

use ultratokenizer_pdf_evidence::{verify_pdf, EvidenceInput};

sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input = sp1_zkvm::io::read::<EvidenceInput>();
    let evidence = verify_pdf(&input.pdf_bytes, &input.approved_signer)
        .unwrap_or_else(|_| panic!("PDF evidence rejected."));
    // An eventual on-chain consumer must compare this public signer fingerprint
    // with its own registry. A prover-supplied input is not issuer authority.
    sp1_zkvm::io::commit_slice(&evidence.public_values());
}
