#!/usr/bin/env python3
"""Sign only an explicitly synthetic capsule supplied by the fixture generator."""
import json
from pathlib import Path
import runpy
import sys


def main() -> None:
    value = sys.stdin.buffer.read(393)
    if len(value) != 392 or any(byte not in b"0123456789abcdef" for byte in value):
        raise ValueError("Expected one fixed synthetic capsule.")
    if bytes.fromhex(value.decode())[:8] != b"UTSG0001":
        raise ValueError("Unsupported synthetic capsule version.")
    factory = runpy.run_path(str(Path(__file__).with_name("generate-fixture.py")))["create_fixture"]
    content = (
        b"BT /F1 12 Tf 40 760 Td (Ultratokenizer synthetic gold certificate) Tj "
        b"0 -20 Td (TEST ONLY - NO ASSET BACKING) Tj "
        b"0 -20 Td (The signed versioned capsule is authoritative.) Tj ET"
    )
    pdf, metadata = factory(content, b"%ULTRATOKENIZER-SYNTHETIC-GOLD-V1 " + value + b"\n")
    destination = Path(__file__).resolve().parents[1] / "claim-evidence" / "fixtures"
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "gold-certificate.synthetic.pdf").write_bytes(pdf)
    sys.stdout.write(json.dumps(metadata))


if __name__ == "__main__":
    main()
