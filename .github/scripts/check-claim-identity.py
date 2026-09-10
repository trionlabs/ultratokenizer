#!/usr/bin/env python3
"""Compare a candidate guest build with reviewed pins without updating them."""

import hashlib
import json
import platform
from pathlib import Path
import sys


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: check-claim-identity.py <identity-json> <elf> <new-comparison-json>")
    root = Path(__file__).resolve().parents[2]
    manifest_path = root / "proofs/programs/claim-v2.json"
    manifest = json.loads(manifest_path.read_text())
    identity_path, elf_path, output_path = map(Path, sys.argv[1:])
    result = {
        "schemaVersion": 1,
        "reviewedManifestSha256": digest(manifest_path),
        "reviewedPlatform": manifest["build"]["platform"],
        "measuredPlatform": f"{platform.system()}-{platform.machine()}",
        "productionApproved": False,
    }
    try:
        if identity_path.stat().st_size > 16 * 1024 or elf_path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("Identity input exceeds its bound.")
        actual = json.loads(identity_path.read_text())
        elf_hash = digest(elf_path)
        lock_hash = digest(root / "proofs/Cargo.lock")
        result.update({
            "expectedProgramVKey": manifest["programVKey"],
            "actualProgramVKey": actual["programVkey"],
            "expectedElfSha256": manifest["elfSha256"],
            "actualElfSha256": actual["elfSha256"],
            "independentlyComputedElfSha256": elf_hash,
            "expectedOuterCircuitVersion": manifest["outerCircuitVersion"],
            "actualOuterCircuitVersion": actual["outerCircuitVersion"],
            "expectedCargoLockSha256": manifest["tooling"]["cargoLockSha256"],
            "actualCargoLockSha256": lock_hash,
            "programVKeyMatches": actual["programVkey"] == manifest["programVKey"],
            "elfSelfHashMatches": actual["elfSha256"] == elf_hash,
            "elfMatchesReviewed": elf_hash == manifest["elfSha256"],
            "outerCircuitMatches": actual["outerCircuitVersion"] == manifest["outerCircuitVersion"],
            "cargoLockMatches": lock_hash == manifest["tooling"]["cargoLockSha256"],
        })
        if not all(result[key] for key in ("elfSelfHashMatches", "outerCircuitMatches", "cargoLockMatches")):
            result["status"] = "invalid_identity_evidence"
        elif not result["programVKeyMatches"]:
            result["status"] = "program_identity_mismatch"
        elif not result["elfMatchesReviewed"]:
            result["status"] = "elf_reproducibility_gap"
        else:
            result["status"] = "matched"
    except (OSError, ValueError, KeyError, TypeError):
        result["status"] = "invalid_identity_evidence"
    rendered = json.dumps(result, indent=2) + "\n"
    with output_path.open("x") as stream:
        stream.write(rendered)
    print(rendered, end="")
    return 0 if result["status"] == "matched" else 1


if __name__ == "__main__":
    raise SystemExit(main())
