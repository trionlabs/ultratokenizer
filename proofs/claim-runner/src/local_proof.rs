//! Explicit local proof generation and independent cryptographic verification.
//! Core proofs are not zero knowledge and must not be shared as private receipts.

use super::{read_bounded, MAX_CYCLES};
use bincode::Options;
use sha2::{Digest, Sha256};
use sp1_core_executor::{SP1CoreOpts, ShardingThreshold};
use sp1_sdk::{
    Elf, HashableKey, ProveRequest, Prover, ProverClient, ProvingKey, SP1Proof,
    SP1ProofWithPublicValues, SP1Stdin, SP1_CIRCUIT_VERSION,
};
use std::{env, fs::OpenOptions, io::Write, path::Path};
use ultratokenizer_claim_evidence::{
    request::{Request, MAX_REQUEST_BYTES},
    verify_claim, ClaimInput, MAX_DOCUMENT_BYTES, PUBLIC_VALUES_BYTES,
};

const EXPECTED_CIRCUIT_VERSION: &str = "v6.1.0";
const MAX_PROOF_BYTES: usize = 64 * 1024 * 1024;

fn options() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PROOF_BYTES as u64)
        .reject_trailing_bytes()
}

fn check_runtime() -> Result<(), &'static str> {
    if SP1_CIRCUIT_VERSION != EXPECTED_CIRCUIT_VERSION {
        return Err("Unexpected SP1 outer circuit version.");
    }
    // The SDK can dump private stdin or select an alternate Gnark executable via
    // these environment variables. This CLI refuses those overrides.
    for name in [
        "SP1_DUMP",
        "SP1_GNARK_IMAGE",
        "SP1_CIRCUIT_MODE",
        "WITHOUT_VK_VERIFICATION",
    ] {
        if env::var_os(name).is_some() {
            return Err("Unsafe SP1 runtime override is set.");
        }
    }
    Ok(())
}

fn mode(proof: &SP1ProofWithPublicValues) -> Result<(&'static str, bool), &'static str> {
    if proof.sp1_version != EXPECTED_CIRCUIT_VERSION || proof.tee_proof.is_some() {
        return Err("Proof wrapper version or format is not supported.");
    }
    match &proof.proof {
        SP1Proof::Core(shards) if !shards.is_empty() => Ok(("core", false)),
        SP1Proof::Groth16(wrapped)
            if !wrapped.encoded_proof.is_empty()
                && wrapped.encoded_proof.len() <= 4096
                && wrapped.encoded_proof.len() % 2 == 0
                && wrapped
                    .encoded_proof
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                && wrapped.public_inputs.iter().all(|value| {
                    ultratokenizer_claim_evidence::request::decimal(value, 256, true).is_ok()
                }) =>
        {
            Ok(("groth16", true))
        }
        _ => Err("Empty, mocked or unsupported proof format."),
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Output already exists or cannot be created.")?;
    file.write_all(bytes)
        .map_err(|_| "Unable to write proof output.")?;
    file.sync_all().map_err(|_| "Unable to flush proof output.")
}

pub async fn run(args: &[String]) -> Result<(), &'static str> {
    check_runtime()?;
    match args.first().map(String::as_str) {
        Some("identity") if args.len() == 2 => {
            let bytes = read_bounded(&args[1], 32 * 1024 * 1024)?;
            let elf_hash = hex::encode(Sha256::digest(&bytes));
            let client = ProverClient::builder().light().build().await;
            let key = client.setup(Elf::from(bytes)).await.map_err(|_| "Guest setup failed.")?;
            println!("{}", serde_json::json!({"programVkey":key.verifying_key().bytes32(), "elfSha256":elf_hash, "outerCircuitVersion":EXPECTED_CIRCUIT_VERSION}));
            Ok(())
        }
        Some("prove-local") if args.len() == 8 => prove(args).await,
        Some("verify-local") if args.len() == 5 => verify(args).await,
        _ => Err("Usage: claim-runner identity <elf> | prove-local <core|groth16> <elf> <pdf> <request-json> <approved-spki-sha256-hex> <expected-program-vkey> <new-proof-file> | verify-local <elf> <request-json> <proof-file> <expected-program-vkey>"),
    }
}

async fn prove(args: &[String]) -> Result<(), &'static str> {
    let requested_mode = args[1].as_str();
    if !matches!(requested_mode, "core" | "groth16") {
        return Err("Only explicit core or Groth16 mode is supported.");
    }
    let elf_bytes = read_bounded(&args[2], 32 * 1024 * 1024)?;
    let pdf = read_bounded(&args[3], MAX_DOCUMENT_BYTES)?;
    let request = read_bounded(&args[4], MAX_REQUEST_BYTES)?;
    let mut approved_signer = [0; 32];
    hex::decode_to_slice(&args[5], &mut approved_signer)
        .map_err(|_| "Invalid signer fingerprint.")?;
    let input = ClaimInput {
        approved_signer,
        request_json: &request,
        pdf_bytes: &pdf,
    };
    let expected = verify_claim(&input).map_err(|_| "Claim did not pass native verification.")?;
    if Path::new(&args[7]).exists() {
        return Err("Proof output already exists.");
    }
    if requested_mode == "groth16" {
        let docker = std::process::Command::new("docker")
            .arg("info")
            .output()
            .map_err(|_| "Local Docker is required for Groth16.")?;
        if !docker.status.success() {
            return Err("Local Docker is unavailable.");
        }
    }
    // Bound guest execution and trace shards. The SDK's worker process memory
    // still needs an external watchdog; these are not a total process RSS limit.
    let opts = SP1CoreOpts {
        minimal_trace_chunk_threshold: 1 << 18,
        trace_chunk_slots: 2,
        memory_limit: 512 * 1024 * 1024,
        shard_size: 1 << 18,
        sharding_threshold: ShardingThreshold {
            element_threshold: 1 << 24,
            height_threshold: 1 << 18,
        },
        drop_ldes: true,
        ..SP1CoreOpts::default()
    };
    let client = ProverClient::builder().cpu().core_opts(opts).build().await;
    eprintln!("Preparing the pinned local proving key.");
    let key = client
        .setup(Elf::from(elf_bytes.clone()))
        .await
        .map_err(|_| "Guest setup failed.")?;
    if key.verifying_key().bytes32() != args[6] {
        return Err("Guest program does not match the pinned verification key.");
    }
    let mut stdin = SP1Stdin::new();
    stdin.write_vec(input.encode().map_err(|_| "Witness encoding failed.")?);
    let started = std::time::Instant::now();
    eprintln!("Generating the requested local cryptographic proof.");
    let proof = if requested_mode == "groth16" {
        client
            .prove(&key, stdin)
            .cycle_limit(MAX_CYCLES)
            .groth16()
            .await
    } else {
        client
            .prove(&key, stdin)
            .cycle_limit(MAX_CYCLES)
            .core()
            .await
    }
    .map_err(|_| "Local cryptographic proof generation failed.")?;
    let (actual_mode, zero_knowledge) = mode(&proof)?;
    if actual_mode != requested_mode || proof.public_values.as_slice() != expected.public_values() {
        return Err("Generated proof mode or public values did not match the verified claim.");
    }
    eprintln!("Checking the generated proof cryptographically.");
    client
        .verify(&proof, key.verifying_key(), None)
        .map_err(|_| "Generated proof failed cryptographic verification.")?;
    let encoded = options()
        .serialize(&proof)
        .map_err(|_| "Proof exceeds its encoding limit.")?;
    write_new(Path::new(&args[7]), &encoded)?;
    println!(
        "{}",
        serde_json::json!({
            "status":"proof_generated_and_verified", "prover":"local_cpu", "proofMode":actual_mode,
            "cryptographicProof":true, "zeroKnowledge":zero_knowledge,
            "programVkey":key.verifying_key().bytes32(), "elfSha256":hex::encode(Sha256::digest(&elf_bytes)),
            "outerCircuitVersion":EXPECTED_CIRCUIT_VERSION, "proofBytes":encoded.len(),
            "elapsedSeconds":started.elapsed().as_secs_f64(),
            "publicValues":format!("0x{}", hex::encode(proof.public_values.as_slice())),
        })
    );
    Ok(())
}

async fn verify(args: &[String]) -> Result<(), &'static str> {
    let elf = Elf::from(read_bounded(&args[1], 32 * 1024 * 1024)?);
    let request = Request::from_json(&read_bounded(&args[2], MAX_REQUEST_BYTES)?)
        .map_err(|_| "Invalid expected request.")?;
    let proof: SP1ProofWithPublicValues = options()
        .deserialize(&read_bounded(&args[3], MAX_PROOF_BYTES)?)
        .map_err(|_| "Invalid proof encoding.")?;
    let (proof_mode, zero_knowledge) = mode(&proof)?;
    let values = proof.public_values.as_slice();
    if values.len() != PUBLIC_VALUES_BYTES
        || values[..32] != ultratokenizer_claim_evidence::request::word_u64(1)
        || values[32..64] != request.digest()
        || values[128..160] != request.claim_usage_id
        || values[160..192] != request.claim_commitment
        || values[192..216] != [0; 24]
        || &values[216..224] < request.valid_until.to_be_bytes().as_slice()
    {
        return Err("Proof is not bound to the expected request.");
    }
    let client = ProverClient::builder().light().build().await;
    let key = client.setup(elf).await.map_err(|_| "Guest setup failed.")?;
    if key.verifying_key().bytes32() != args[4] {
        return Err("Guest program does not match the pinned verification key.");
    }
    client
        .verify(&proof, key.verifying_key(), None)
        .map_err(|_| "Cryptographic proof verification failed.")?;
    let mut result = serde_json::json!({"status":"cryptographic_proof_verified", "proofMode":proof_mode,
        "zeroKnowledge":zero_knowledge, "issuerAuthorityChecked":false,
        "programVkey":key.verifying_key().bytes32(), "outerCircuitVersion":EXPECTED_CIRCUIT_VERSION,
        "requestDigest":format!("0x{}", hex::encode(request.digest()))});
    if zero_knowledge {
        result["evmProof"] = format!("0x{}", hex::encode(proof.bytes())).into();
        result["publicValues"] = format!("0x{}", hex::encode(values)).into();
    }
    println!("{result}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sp1_sdk::SP1PublicValues;

    #[test]
    fn empty_core_proofs_and_unexpected_versions_are_never_success() {
        let empty = SP1ProofWithPublicValues::new(
            SP1Proof::Core(Vec::new()),
            SP1PublicValues::new(),
            EXPECTED_CIRCUIT_VERSION.into(),
        );
        assert!(mode(&empty).is_err());
        let mut wrong_version = empty;
        wrong_version.sp1_version = "unsupported".into();
        assert!(mode(&wrong_version).is_err());
    }

    #[test]
    fn malformed_serialized_proofs_fail_without_a_fallback() {
        for bytes in [&[][..], &[0xff; 8][..], &[0x00; 64][..]] {
            assert!(options()
                .deserialize::<SP1ProofWithPublicValues>(bytes)
                .is_err());
        }
    }

    #[test]
    fn malformed_groth16_hex_and_unbounded_public_integers_are_rejected() {
        let mut proof = SP1ProofWithPublicValues::new(
            SP1Proof::Groth16(Default::default()),
            SP1PublicValues::new(),
            EXPECTED_CIRCUIT_VERSION.into(),
        );
        if let SP1Proof::Groth16(wrapped) = &mut proof.proof {
            wrapped.public_inputs = std::array::from_fn(|_| "0".into());
            wrapped.encoded_proof = "not-hexadecimal".into();
        }
        assert!(mode(&proof).is_err());
        if let SP1Proof::Groth16(wrapped) = &mut proof.proof {
            wrapped.encoded_proof = "00".repeat(352);
            wrapped.public_inputs[1] = "9".repeat(1000);
        }
        assert!(mode(&proof).is_err());
    }
}
