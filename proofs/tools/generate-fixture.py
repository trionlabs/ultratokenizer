#!/usr/bin/env python3
"""Create a synthetic signed PDF with OpenSSL. Never writes a private key to the repository."""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def openssl(*args: str) -> bytes:
    result = subprocess.run(["openssl", *args], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("OpenSSL fixture generation failed.")
    return result.stdout


def main() -> None:
    destination = Path(__file__).resolve().parents[1] / "pdf-evidence" / "fixtures"
    destination.mkdir(parents=True, exist_ok=True)
    placeholder = b"[0000000000 0000000000 0000000000 0000000000]"
    signature_space = 8192
    content = (
        b"BT /F1 12 Tf 40 760 Td (Ultratokenizer synthetic statement) Tj "
        b"0 -20 Td (Asset: GOLD) Tj 0 -20 Td (Unit: MILLIGRAM) Tj "
        b"0 -20 Td (Balance: 10000) Tj "
        b"0 -20 Td (Holder: Synthetic Holder) Tj "
        b"0 -20 Td (StatementDate: 2026-09-08) Tj ET"
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
        b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [7 0 R] >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Fields [7 0 R] /SigFlags 3 >>",
        b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (SyntheticSignature) "
        b"/Rect [0 0 0 0] /V 8 0 R /P 3 0 R >>",
        b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached "
        b"/ByteRange " + placeholder + b" /Contents <" + b"0" * (signature_space * 2) + b"> >>",
    ]
    pdf = bytearray(b"%PDF-1.7\n")
    offsets = [0]
    for index, body in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(str(index).encode() + b" 0 obj\n" + body + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 9\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(b"trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    gap_start = pdf.index(b"/Contents <") + len(b"/Contents ")
    gap_end = gap_start + signature_space * 2 + 2
    ranges = [0, gap_start, gap_end, len(pdf) - gap_end]
    replacement = ("[" + " ".join(f"{value:010d}" for value in ranges) + "]").encode()
    pdf = pdf.replace(placeholder, replacement, 1)
    signed_bytes = bytes(pdf[:gap_start] + pdf[gap_end:])

    with tempfile.TemporaryDirectory(prefix="ultratokenizer-fixture-") as temporary:
        temporary = Path(temporary)
        key, cert, body, signature = [temporary / name for name in ("key.pem", "cert.pem", "body.bin", "signature.der")]
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "30",
                "-subj", "/CN=Ultratokenizer Synthetic Signer/O=Test Fixtures",
                "-keyout", str(key), "-out", str(cert))
        body.write_bytes(signed_bytes)
        openssl("cms", "-sign", "-binary", "-in", str(body), "-signer", str(cert),
                "-inkey", str(key), "-md", "sha256", "-nosmimecap", "-outform", "DER", "-out", str(signature))
        # Independently verify the generated CMS signature; the self-signed test
        # certificate is deliberate, so PKI-chain validation is outside this check.
        openssl("cms", "-verify", "-binary", "-inform", "DER", "-in", str(signature),
                "-content", str(body), "-noverify", "-out", str(temporary / "verified.bin"))
        signature_hex = signature.read_bytes().hex().encode()
        if len(signature_hex) > signature_space * 2:
            raise RuntimeError("Signature exceeds the fixture's reserved space.")
        pdf[gap_start + 1:gap_end - 1] = signature_hex.ljust(signature_space * 2, b"0")
        public_key = openssl("pkey", "-in", str(key), "-pubout", "-outform", "DER")

    fingerprint = hashlib.sha256(public_key).hexdigest()
    signed_digest = hashlib.sha256(signed_bytes).hexdigest()
    metadata = {
        "synthetic": True,
        "signerFingerprintAlgorithm": "sha256-spki-der",
        "signerFingerprint": fingerprint,
        "signedDigest": signed_digest,
        "fileSha256": hashlib.sha256(pdf).hexdigest(),
        "publicValues": (1).to_bytes(32, "big").hex() + fingerprint + signed_digest,
    }
    (destination / "statement.synthetic.pdf").write_bytes(pdf)
    (destination / "statement.synthetic.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Created a synthetic signed PDF and public verification metadata. No private key retained.")


if __name__ == "__main__":
    main()
