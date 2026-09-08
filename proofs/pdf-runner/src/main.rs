use sp1_sdk::{Elf, Prover, ProverClient, SP1Stdin};
use std::{env, fs::File, io::Read, process::ExitCode};
use ultratokenizer_pdf_evidence::{verify_pdf, EvidenceInput, MAX_PDF_BYTES};

fn read_bounded(path: &str, maximum: usize) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Unable to open input file.")?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read input file.")?;
    if bytes.len() > maximum {
        return Err("Input exceeds its size limit.");
    }
    Ok(bytes)
}

async fn execute(elf: Elf, input: &EvidenceInput) -> Result<(Vec<u8>, u64, u64), &'static str> {
    // Explicitly local. No from_env(), network prover, credentials or paid proving.
    let client = ProverClient::builder().light().build().await;
    let mut stdin = SP1Stdin::new();
    stdin.write(input);
    let (values, report) = client
        .execute(elf, stdin)
        .await
        .map_err(|_| "SP1 execution failed.")?;
    Ok((
        values.as_slice().to_vec(),
        report.total_instruction_count(),
        report.exit_code,
    ))
}

async fn run() -> Result<(), &'static str> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.len() == 2 && arguments[0] == "self-test" {
        return self_test(Elf::from(read_bounded(&arguments[1], 32 * 1024 * 1024)?)).await;
    }
    if arguments.len() != 4 || arguments[0] != "execute" {
        return Err(
            "Usage: pdf-runner execute <elf> <pdf> <approved-spki-sha256-hex> | self-test <elf>",
        );
    }
    let elf = Elf::from(read_bounded(&arguments[1], 32 * 1024 * 1024)?);
    let mut signer = [0; 32];
    hex::decode_to_slice(&arguments[3], &mut signer).map_err(|_| "Invalid signer fingerprint.")?;
    let input = EvidenceInput {
        pdf_bytes: read_bounded(&arguments[2], MAX_PDF_BYTES)?,
        approved_signer: signer,
    };
    let expected = verify_pdf(&input.pdf_bytes, &input.approved_signer)
        .map_err(|_| "PDF did not pass native verification.")?;
    let (values, instructions, exit_code) = execute(elf, &input).await?;
    if exit_code != 0 || values != expected.public_values() {
        return Err("Guest output did not match native verification.");
    }
    println!("{{\"status\":\"signature_verified\",\"execution\":\"sp1\",\"zkProof\":false,\"instructions\":{instructions},\"publicValues\":\"0x{}\"}}", hex::encode(values));
    Ok(())
}

async fn self_test(elf: Elf) -> Result<(), &'static str> {
    let metadata: serde_json::Value = serde_json::from_str(include_str!(
        "../../pdf-evidence/fixtures/statement.synthetic.json"
    ))
    .map_err(|_| "Synthetic metadata is invalid.")?;
    let mut signer = [0; 32];
    hex::decode_to_slice(
        metadata["signerFingerprint"]
            .as_str()
            .ok_or("Missing fingerprint.")?,
        &mut signer,
    )
    .map_err(|_| "Invalid synthetic fingerprint.")?;
    let pdf = include_bytes!("../../pdf-evidence/fixtures/statement.synthetic.pdf").to_vec();
    let input = EvidenceInput {
        pdf_bytes: pdf.clone(),
        approved_signer: signer,
    };
    let (values, instructions, exit_code) = execute(elf.clone(), &input).await?;
    let expected = metadata["publicValues"]
        .as_str()
        .ok_or("Missing public values.")?;
    let native = verify_pdf(&input.pdf_bytes, &input.approved_signer)
        .map_err(|_| "Valid fixture failed native verification.")?;
    if hex::encode(native.public_values()) != expected {
        return Err("Native output did not match fixture metadata.");
    }
    if exit_code != 0 || hex::encode(values) != expected {
        return Err("Valid fixture failed SP1 public-output parity.");
    }
    let mut tampered = pdf.clone();
    let position = tampered
        .windows(b"Balance: 10000".len())
        .position(|bytes| bytes == b"Balance: 10000")
        .ok_or("Missing synthetic balance.")?;
    tampered[position + b"Balance: ".len()] = b'9';
    let mut appended = pdf.clone();
    appended.extend_from_slice(b"\n9 0 obj << /Other 1 >> endobj\n%%EOF\n");
    let mut malformed_cms = pdf.clone();
    let contents_marker = b"/Contents <";
    let contents = malformed_cms
        .windows(contents_marker.len())
        .position(|bytes| bytes == contents_marker)
        .ok_or("Missing synthetic signature container.")?
        + contents_marker.len();
    // This DER length previously overflowed inside the upstream extractor.
    malformed_cms[contents..contents + 20].copy_from_slice(b"3088ffffffffffffffff");
    for rejected in [
        EvidenceInput {
            pdf_bytes: tampered,
            approved_signer: signer,
        },
        EvidenceInput {
            pdf_bytes: pdf,
            approved_signer: [0x55; 32],
        },
        EvidenceInput {
            pdf_bytes: appended,
            approved_signer: signer,
        },
        EvidenceInput {
            pdf_bytes: malformed_cms,
            approved_signer: signer,
        },
    ] {
        if verify_pdf(&rejected.pdf_bytes, &rejected.approved_signer).is_ok() {
            return Err("Invalid evidence passed native verification.");
        }
        let (values, _, exit_code) = execute(elf.clone(), &rejected).await?;
        if exit_code == 0 || !values.is_empty() {
            return Err("Invalid evidence was accepted or produced public output.");
        }
    }
    println!("{{\"status\":\"passed\",\"execution\":\"sp1\",\"zkProof\":false,\"cases\":5,\"validInstructions\":{instructions}}}");
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
