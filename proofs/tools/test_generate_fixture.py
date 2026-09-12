#!/usr/bin/env python3
"""Manual regression check: python3 proofs/tools/test_generate_fixture.py."""

import hashlib
from pathlib import Path
import re
import runpy
import tempfile
import unittest


fixture_tools = runpy.run_path(str(Path(__file__).with_name("generate-fixture.py")))
create_fixture = fixture_tools["create_fixture"]
openssl = fixture_tools["openssl"]
CONTENT = b"BT /F1 12 Tf 40 760 Td (Synthetic batch document one) Tj ET"


class GenerateFixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ultratokenizer-fixture-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def identity(self):
        key, certificate = self.directory / "key.pem", self.directory / "cert.pem"
        for path in (key, certificate):
            path.touch(mode=0o600)
        openssl(
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
            "-subj", "/CN=Temporary Synthetic Batch/O=Test Fixtures",
            "-keyout", str(key), "-out", str(certificate),
        )
        for path in (key, certificate):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        return key, certificate

    def verify_cms(self, pdf):
        match = re.search(rb"/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]", pdf)
        self.assertIsNotNone(match)
        start, first_length, second_start, second_length = map(int, match.groups())
        self.assertEqual(start, 0)
        self.assertEqual(second_start + second_length, len(pdf))
        self.assertEqual(pdf[first_length:first_length + 1], b"<")
        self.assertEqual(pdf[second_start - 1:second_start], b">")
        body = self.directory / "signed-body.bin"
        signature = self.directory / "signature.der"
        body.write_bytes(pdf[:first_length] + pdf[second_start:])
        signature.write_bytes(bytes.fromhex(pdf[first_length + 1:second_start - 1].decode()))
        # Check the signature over bytes extracted from the returned PDF. The
        # synthetic self-signed certificate establishes no external PKI trust.
        openssl(
            "cms", "-verify", "-binary", "-inform", "DER", "-in", str(signature),
            "-content", str(body), "-noverify", "-out", str(self.directory / "verified.bin"),
        )

    def test_shared_identity_signs_distinct_pdfs_and_rejects_tampering(self):
        identity = self.identity()
        public_key = self.directory / "public-key.pem"
        public_key.write_bytes(openssl("x509", "-in", str(identity[1]), "-pubkey", "-noout"))
        spki = openssl("pkey", "-pubin", "-in", str(public_key), "-outform", "DER")
        expected_fingerprint = hashlib.sha256(spki).hexdigest()
        fingerprints, digests = [], []
        for word in (b"one", b"two"):
            with self.subTest(document=word.decode()):
                pdf, metadata = create_fixture(
                    CONTENT.replace(b"one", word),
                    capsule=b"% synthetic signed capsule\n",
                    signing_identity=identity,
                )
                self.verify_cms(pdf)
                fingerprints.append(metadata["signerFingerprint"])
                digests.append(metadata["signedDigest"])
                tampered = pdf.replace(b"Synthetic batch", b"Synthetic patch", 1)
                self.assertNotEqual(tampered, pdf)
                with self.assertRaises(RuntimeError):
                    self.verify_cms(tampered)
        self.assertEqual(fingerprints, [expected_fingerprint, expected_fingerprint])
        self.assertNotEqual(digests[0], digests[1])

    def test_default_signing_uses_fresh_valid_identities(self):
        fingerprints = []
        for _ in range(2):
            pdf, metadata = create_fixture(CONTENT)
            self.verify_cms(pdf)
            fingerprints.append(metadata["signerFingerprint"])
        self.assertNotEqual(fingerprints[0], fingerprints[1])

    def test_group_or_other_readable_private_key_is_rejected(self):
        key, certificate = self.identity()
        key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "mode 0600"):
            create_fixture(CONTENT, signing_identity=(key, certificate))


if __name__ == "__main__":
    unittest.main()
