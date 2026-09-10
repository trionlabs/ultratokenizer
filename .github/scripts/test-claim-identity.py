"""Adversarial checks for candidate reporting versus reviewed-program admission."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "claim_identity", Path(__file__).with_name("check-claim-identity.py")
)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class IdentityPolicyTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {
            "programVKey": "0x" + "11" * 32,
            "elfSha256": "22" * 32,
            "outerCircuitVersion": "v6.1.0",
        }
        self.identity = {
            "programVkey": self.manifest["programVKey"],
            "elfSha256": self.manifest["elfSha256"],
            "outerCircuitVersion": "v6.1.0",
        }

    def compare(self, mode="require-reviewed", **changes):
        return checker.compare(
            self.manifest, {**self.identity, **changes},
            self.manifest["elfSha256"], True, mode,
        )

    def test_same_identity_is_matched(self):
        self.assertEqual(self.compare()["status"], "matched")

    def test_candidate_gap_is_reported_without_admission(self):
        result = self.compare("record-candidate", programVkey="0x" + "33" * 32)
        self.assertEqual(result["status"], "program_identity_mismatch")
        self.assertTrue(result["comparisonAccepted"])
        self.assertTrue(result["requiresAdmissionReview"])

    def test_default_mode_rejects_a_changed_key(self):
        self.assertFalse(self.compare(programVkey="0x" + "33" * 32)["comparisonAccepted"])

    def test_same_key_different_elf_is_never_silently_matched(self):
        actual = {**self.identity, "elfSha256": "44" * 32}
        for mode in ("require-reviewed", "record-candidate"):
            result = checker.compare(self.manifest, actual, "44" * 32, True, mode)
            self.assertEqual(result["status"], "elf_reproducibility_gap")
            self.assertTrue(result["requiresAdmissionReview"])
            self.assertEqual(result["comparisonAccepted"], mode == "record-candidate")

    def test_candidate_mode_still_rejects_corrupted_evidence(self):
        for changes in (
            {"elfSha256": "44" * 32},
            {"outerCircuitVersion": "v0"},
            {"programVkey": "invalid"},
            {"programVkey": None},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(self.compare("record-candidate", **changes)["comparisonAccepted"])

    def test_unreviewed_build_inputs_fail_even_in_report_mode(self):
        result = checker.compare(
            self.manifest, self.identity, self.manifest["elfSha256"],
            False, "record-candidate",
        )
        self.assertEqual(result["status"], "invalid_identity_evidence")
        self.assertFalse(result["comparisonAccepted"])

    def test_cli_retains_failure_record_for_non_object_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            elf = directory / "candidate.elf"
            elf.write_bytes(b"\x7fELFtest")
            for index, value in enumerate((None, [], "invalid")):
                identity = directory / f"identity-{index}.json"
                output = directory / f"comparison-{index}.json"
                identity.write_text(json.dumps(value))
                completed = subprocess.run([
                    sys.executable, str(Path(__file__).with_name("check-claim-identity.py")),
                    str(identity), str(elf), str(output), "--mode", "record-candidate",
                ], capture_output=True, text=True)
                self.assertEqual(completed.returncode, 1)
                self.assertTrue(output.is_file(), completed.stderr)
                self.assertEqual(json.loads(output.read_text())["status"], "invalid_identity_evidence")


if __name__ == "__main__":
    unittest.main()
