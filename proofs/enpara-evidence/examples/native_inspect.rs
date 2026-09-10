//! Local diagnostic only; all arguments remain on this machine.
use ultratokenizer_pdf_evidence::reviewed_revision::{verify_reviewed_revision, ApprovedRevision};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 5 {
        return Err("usage: native_inspect <pdf> <signer-spki-sha256> <complete-pdf-sha256> <selected-revision-bytes>".into());
    }
    let hex32 = |s: &str| -> Result<[u8; 32], Box<dyn std::error::Error>> {
        hex::decode(s)?
            .try_into()
            .map_err(|_| "expected 32 bytes".into())
    };
    let path = &args[1];
    if std::fs::metadata(path)?.len() > 512 * 1024 {
        return Err("document exceeds supported size".into());
    }
    let bytes = std::fs::read(path)?;
    let approval = ApprovedRevision {
        signer_fingerprint: hex32(&args[2])?,
        full_document_sha256: hex32(&args[3])?,
        signed_revision_bytes: args[4].parse()?,
    };
    let verified = verify_reviewed_revision(&bytes, &approval)?;
    let _private_statement = ultratokenizer_enpara_evidence::extract_available_xau(&verified)?;
    println!("{{\"selectedRevisionSignatureVerified\":true,\"nativeQuantityExtraction\":true,\"quantityDisclosed\":false,\"issuerAuthorityAuthenticated\":false,\"certificateChainValidated\":false,\"zkProof\":false}}");
    Ok(())
}
