use sp1_sdk::{Elf, Prover, ProverClient, SP1Stdin};
use std::{env, fs::File, io::Read, process::ExitCode};
use ultratokenizer_claim_evidence::{
    claim_usage_id, request::MAX_REQUEST_BYTES, verify_claim, ClaimInput, CAPSULE_MARKER,
    MAX_DOCUMENT_BYTES, MAX_WITNESS_BYTES,
};

const MAX_CYCLES: u64 = 100_000_000;

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

fn decode_word(value: &str) -> Result<[u8; 32], &'static str> {
    let raw = value
        .strip_prefix("0x")
        .ok_or("Claim identity word must be 0x-prefixed hex.")?;
    let mut word = [0; 32];
    hex::decode_to_slice(raw, &mut word).map_err(|_| "Invalid claim identity word.")?;
    if word == [0; 32] {
        return Err("Claim identity word must be nonzero.");
    }
    Ok(word)
}

async fn execute(elf: Elf, witness: Vec<u8>) -> Result<(Vec<u8>, u64, u64), &'static str> {
    // The network feature is disabled, and this client only executes locally.
    let client = ProverClient::builder().light().build().await;
    let mut stdin = SP1Stdin::new();
    stdin.write_vec(witness);
    let (values, report) = client
        .execute(elf, stdin)
        .cycle_limit(MAX_CYCLES)
        .await
        .map_err(|_| "Local SP1 execution failed or exceeded its cycle limit.")?;
    Ok((
        values.as_slice().to_vec(),
        report.total_instruction_count(),
        report.exit_code,
    ))
}

async fn run() -> Result<(), &'static str> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() == 2 && args[0] == "request-digest" {
        let request = ultratokenizer_claim_evidence::request::Request::from_json(&read_bounded(
            &args[1],
            MAX_REQUEST_BYTES,
        )?)
        .map_err(|_| "Invalid issuance request.")?;
        println!(
            "{}",
            serde_json::json!({"status":"request_digest_computed", "requestDigest":format!("0x{}", hex::encode(request.digest()))})
        );
        return Ok(());
    }
    if args.len() == 3 && args[0] == "claim-usage" {
        let source_id = decode_word(&args[1])?;
        let claim_id = decode_word(&args[2])?;
        let usage = claim_usage_id(source_id, claim_id);
        println!(
            "{}",
            serde_json::json!({
                "status":"claim_usage_computed",
                "claimUsageId":format!("0x{}", hex::encode(usage))
            })
        );
        return Ok(());
    }
    if matches!(
        args.first().map(String::as_str),
        Some("identity" | "prove-local" | "verify-local" | "export-groth16")
    ) {
        return local_proof::run(&args).await;
    }
    if matches!(
        args.first().map(String::as_str),
        Some("network-prepare-synthetic" | "network-prepare-reviewed-synthetic")
    ) {
        return network_request::run(&args).await;
    }
    if args.len() == 2 && args[0] == "self-test" {
        return self_test(Elf::from(read_bounded(&args[1], 32 * 1024 * 1024)?)).await;
    }
    let (elf, files) = match args.first().map(String::as_str) {
        Some("native") if args.len() == 4 => (None, &args[1..]),
        Some("execute") if args.len() == 5 => (Some(Elf::from(read_bounded(&args[1], 32 * 1024 * 1024)?)), &args[2..]),
        _ => return Err("Usage: claim-runner native <pdf> <request-json> <approved-spki-sha256-hex> | execute <elf> <pdf> <request-json> <approved-spki-sha256-hex> | self-test <elf>"),
    };
    let pdf = read_bounded(&files[0], MAX_DOCUMENT_BYTES)?;
    let request = read_bounded(&files[1], MAX_REQUEST_BYTES)?;
    let mut approved_signer = [0; 32];
    hex::decode_to_slice(&files[2], &mut approved_signer)
        .map_err(|_| "Invalid signer fingerprint.")?;
    let input = ClaimInput {
        approved_signer,
        request_json: &request,
        pdf_bytes: &pdf,
    };
    let expected = verify_claim(&input).map_err(|_| "Claim did not pass native verification.")?;
    let (backend, instructions) = if let Some(elf) = elf {
        let (values, instructions, exit_code) =
            execute(elf, input.encode().map_err(|_| "Witness encoding failed.")?).await?;
        if exit_code != 0 || values != expected.public_values() {
            return Err("Guest output did not match native verification.");
        }
        ("sp1", instructions)
    } else {
        ("native", 0)
    };
    println!(
        "{}",
        serde_json::json!({
            "status":"claim_verified", "execution":backend, "zkProof":false,
            "profile":"ultratokenizer-synthetic-gold-v2", "instructions":instructions,
            "requestDigest":format!("0x{}", hex::encode(expected.request_digest)),
            "publicValues":format!("0x{}", hex::encode(expected.public_values())),
        })
    );
    Ok(())
}

async fn self_test(elf: Elf) -> Result<(), &'static str> {
    let metadata: serde_json::Value = serde_json::from_str(include_str!(
        "../../claim-evidence/fixtures/gold-certificate.synthetic.json"
    ))
    .map_err(|_| "Invalid synthetic metadata.")?;
    let request = include_bytes!("../../claim-evidence/fixtures/request.synthetic.json");
    let pdf = include_bytes!("../../claim-evidence/fixtures/gold-certificate.synthetic.pdf");
    let mut approved_signer = [0; 32];
    hex::decode_to_slice(
        metadata["signerFingerprint"]
            .as_str()
            .ok_or("Missing synthetic signer.")?,
        &mut approved_signer,
    )
    .map_err(|_| "Invalid synthetic signer.")?;
    let input = ClaimInput {
        approved_signer,
        request_json: request,
        pdf_bytes: pdf,
    };
    let native = verify_claim(&input).map_err(|_| "Valid fixture failed native verification.")?;
    if format!("0x{}", hex::encode(native.public_values())) != metadata["publicValues"] {
        return Err("Native output disagrees with independent viem fixture.");
    }
    let witness = input
        .encode()
        .map_err(|_| "Fixture witness encoding failed.")?;
    let (values, instructions, exit_code) = execute(elf.clone(), witness.clone()).await?;
    if exit_code != 0 || values != native.public_values() {
        return Err("Guest output disagrees with independent viem fixture.");
    }

    let mut rejected = Vec::new();
    let mut changed_pdf = pdf.to_vec();
    changed_pdf[b"%PDF-1.7\n".len() + CAPSULE_MARKER.len() + 16] ^= 1;
    rejected.push(
        ClaimInput {
            approved_signer,
            request_json: request,
            pdf_bytes: &changed_pdf,
        }
        .encode()
        .map_err(|_| "Fixture encoding failed.")?,
    );
    rejected.push(
        ClaimInput {
            approved_signer: [0x99; 32],
            request_json: request,
            pdf_bytes: pdf,
        }
        .encode()
        .map_err(|_| "Fixture encoding failed.")?,
    );
    for (field, value) in [
        ("recipient", format!("0x{}", "99".repeat(20))),
        ("claimUsageId", format!("0x{}", "99".repeat(32))),
        ("amount", "9999".into()),
        ("amount", "10001".into()),
        ("unit", "XAU_GRAM".into()),
        ("validUntil", "2000000001".into()),
    ] {
        let mut changed: serde_json::Value =
            serde_json::from_slice(request).map_err(|_| "Invalid synthetic request.")?;
        changed[field] = value.into();
        let json = serde_json::to_vec(&changed).map_err(|_| "Request encoding failed.")?;
        rejected.push(
            ClaimInput {
                approved_signer,
                request_json: &json,
                pdf_bytes: pdf,
            }
            .encode()
            .map_err(|_| "Fixture encoding failed.")?,
        );
    }
    let mut malformed = witness;
    malformed[40..44].copy_from_slice(&u32::MAX.to_be_bytes());
    rejected.push(malformed);
    rejected.push(vec![0; MAX_WITNESS_BYTES + 1]);
    let cases = rejected.len() + 1;
    for encoded in rejected {
        if ClaimInput::decode(&encoded)
            .and_then(|input| verify_claim(&input))
            .is_ok()
        {
            return Err("Invalid fixture passed native verification.");
        }
        let (values, _, exit_code) = execute(elf.clone(), encoded).await?;
        if exit_code == 0 || !values.is_empty() {
            return Err("Invalid witness succeeded or emitted public output.");
        }
    }
    println!(
        "{}",
        serde_json::json!({"status":"passed", "execution":"sp1", "zkProof":false, "cases":cases, "validInstructions":instructions})
    );
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
mod local_proof;
mod network_request;
