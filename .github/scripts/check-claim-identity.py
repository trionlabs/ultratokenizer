#!/usr/bin/env python3
"""Compare a candidate guest build with reviewed pins without updating them."""

import argparse
import hashlib
import json
import platform
from pathlib import Path
import re


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def compare(manifest, actual, elf_hash, inputs_match, mode):
    valid_shape = isinstance(actual, dict) and set(actual) == {
        "programVkey", "elfSha256", "outerCircuitVersion"
    }
    valid_shape = valid_shape and all(
        isinstance(actual[key], str) and re.fullmatch(pattern, actual[key])
        for key, pattern in (
            ("programVkey", r"0x[0-9a-f]{64}"),
            ("elfSha256", r"[0-9a-f]{64}"),
            ("outerCircuitVersion", r"v[0-9]+\.[0-9]+\.[0-9]+"),
        )
    )
    actual = actual if isinstance(actual, dict) else {}
    result = {
        "expectedProgramVKey": manifest["programVKey"],
        "actualProgramVKey": actual.get("programVkey"),
        "expectedElfSha256": manifest["elfSha256"],
        "actualElfSha256": actual.get("elfSha256"),
        "independentlyComputedElfSha256": elf_hash,
        "expectedOuterCircuitVersion": manifest["outerCircuitVersion"],
        "actualOuterCircuitVersion": actual.get("outerCircuitVersion"),
        "programVKeyMatches": actual.get("programVkey") == manifest["programVKey"],
        "elfSelfHashMatches": actual.get("elfSha256") == elf_hash,
        "elfMatchesReviewed": elf_hash == manifest["elfSha256"],
        "outerCircuitMatches": actual.get("outerCircuitVersion") == manifest["outerCircuitVersion"],
        "buildInputsMatch": inputs_match,
    }
    if not valid_shape or not all(result[key] for key in (
        "elfSelfHashMatches", "outerCircuitMatches", "buildInputsMatch"
    )):
        status = "invalid_identity_evidence"
    elif not result["programVKeyMatches"]:
        status = "program_identity_mismatch"
    elif not result["elfMatchesReviewed"]:
        status = "elf_reproducibility_gap"
    else:
        status = "matched"
    result.update({
        "status": status,
        "requiresAdmissionReview": status != "matched",
        "comparisonAccepted": status == "matched" or (
            mode == "record-candidate" and status in {
                "program_identity_mismatch", "elf_reproducibility_gap"
            }
        ),
    })
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identity", type=Path)
    parser.add_argument("elf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--mode", choices=("require-reviewed", "record-candidate"),
                        default="require-reviewed")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    manifest_path = root / "proofs/programs/claim-v2.json"
    manifest = json.loads(manifest_path.read_text())
    inputs_path = root / "proofs/programs/claim-v2-build-inputs.json"
    inputs = json.loads(inputs_path.read_text())
    identity_path, elf_path, output_path = args.identity, args.elf, args.output
    result = {
        "schemaVersion": 2,
        "comparisonMode": args.mode,
        "reviewedManifestSha256": digest(manifest_path),
        "buildInputsManifestSha256": digest(inputs_path),
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
            "expectedCargoLockSha256": inputs["cargoLockSha256"],
            "actualCargoLockSha256": lock_hash,
            "historicalCargoLockSha256": manifest["tooling"]["cargoLockSha256"],
            "cargoLockMatches": lock_hash == inputs["cargoLockSha256"],
        })
        inputs_match = result["cargoLockMatches"] and (
            inputs["reviewedProgramManifestSha256"] == digest(manifest_path)
        )
        result.update(compare(manifest, actual, elf_hash, inputs_match, args.mode))
        normalized = inputs["candidateMeasurement"]
        result["matchesMeasuredNormalizedCandidate"] = (
            isinstance(actual, dict)
            and actual.get("programVkey") == normalized["programVKey"]
            and elf_hash == normalized["elfSha256"]
        )
    except (OSError, ValueError, KeyError, TypeError):
        result["status"] = "invalid_identity_evidence"
        result["comparisonAccepted"] = False
        result["requiresAdmissionReview"] = True
    rendered = json.dumps(result, indent=2) + "\n"
    with output_path.open("x") as stream:
        stream.write(rendered)
    print(rendered, end="")
    return 0 if result["comparisonAccepted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
