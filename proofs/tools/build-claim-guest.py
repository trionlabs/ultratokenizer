#!/usr/bin/env python3
"""Build a path-remapped candidate without overwriting the staged program ELF."""

import os
from pathlib import Path
import subprocess


def main():
    proofs = Path(__file__).resolve().parents[1]
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")).resolve()
    sysroot = Path(subprocess.check_output(
        ["rustc", "+succinct", "--print", "sysroot"], text=True
    ).strip()).resolve()
    mappings = [(proofs.parent, "/workspace"), (cargo_home, "/cargo"), (sysroot, "/rust")]
    # Registry index directory names can differ with Cargo's registry transport.
    mappings.extend((path, "/cargo/registry/src") for path in sorted(
        (cargo_home / "registry/src").glob("*")
    ) if path.is_dir())
    # rustc applies the last matching prefix. Put more specific mappings last.
    mappings.sort(key=lambda item: len(str(item[0])))
    flags = [f"--remap-path-prefix={source}={target}" for source, target in mappings]
    if any("," in str(source) or "=" in str(source) for source, _ in mappings):
        raise SystemExit("Build paths cannot contain a comma or equals sign.")
    subprocess.run([
        "cargo", "prove", "build", "--locked", "--packages", "ultratokenizer-claim-guest",
        "--output-directory", "target/normalized-elf", "--rustflags=" + ",".join(flags),
    ], cwd=proofs, check=True)


if __name__ == "__main__":
    main()
