use std::{env, fs::File, io::Read, process::ExitCode};
use ultratokenizer_pdf_evidence::{verify_pdf, MAX_PDF_BYTES};

fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.len() != 2 {
        return Err("Usage: verify <pdf-path> <approved-spki-sha256-hex>".into());
    }
    let mut signer = [0; 32];
    hex::decode_to_slice(&arguments[1], &mut signer).map_err(|_| "Invalid signer fingerprint.")?;
    let mut bytes = Vec::new();
    File::open(&arguments[0])
        .map_err(|_| "Unable to open PDF.")?
        .take(MAX_PDF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read PDF.")?;
    let evidence = verify_pdf(&bytes, &signer).map_err(|error| error.to_string())?;
    println!("{{\"status\":\"signature_verified\",\"execution\":\"native\",\"zkProof\":false,\"profileVersion\":{},\"signerFingerprint\":\"0x{}\",\"signedDigest\":\"0x{}\",\"publicValues\":\"0x{}\"}}",
        evidence.profile_version, hex::encode(evidence.signer_fingerprint),
        hex::encode(evidence.signed_digest), hex::encode(evidence.public_values()));
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
