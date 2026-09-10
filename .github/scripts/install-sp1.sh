#!/usr/bin/env bash
set -euo pipefail

# Pinned Linux CI assets. Do not run an upstream installer script or use a moving tag.
# Provenance: succinctlabs/sp1@cfb55443120fe5a13f63eaf60bdab6edc269c9a1.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
sp1_install_dir="$(mktemp -d "${RUNNER_TEMP:?}/ultratokenizer-sp1.XXXXXX")"
sp1_bin_dir="$sp1_install_dir/bin"
sp1_rust_dir="$sp1_install_dir/rust"
mkdir -p "$sp1_bin_dir" "$sp1_rust_dir"

curl --fail --silent --show-error --location --retry 3 --proto '=https' \
  https://github.com/succinctlabs/sp1/releases/download/v6.2.4/cargo_prove_v6.2.4_linux_amd64.tar.gz \
  --output "$sp1_install_dir/cli.tar.gz"
curl --fail --silent --show-error --location --retry 3 --proto '=https' \
  https://github.com/succinctlabs/rust/releases/download/succinct-1.94.0-64bit/rust-toolchain-x86_64-unknown-linux-gnu.tar.gz \
  --output "$sp1_install_dir/rust.tar.gz"
printf '%s  %s\n' \
  a2e7d84da494f9a3f59421abcdcee68049f24b29e6dc3620dbe9f32413c79eec "$sp1_install_dir/cli.tar.gz" \
  12c94435d41bfe4e20131bbcce40b35abd32270ad792befc653af4e3fabc192f "$sp1_install_dir/rust.tar.gz" \
  | sha256sum --check --strict

# The pinned official installers extract both archives without stripping a prefix.
tar -xzf "$sp1_install_dir/cli.tar.gz" -C "$sp1_bin_dir"
tar -xzf "$sp1_install_dir/rust.tar.gz" -C "$sp1_rust_dir"
test -x "$sp1_bin_dir/cargo-prove"
test -x "$sp1_rust_dir/bin/rustc"
rustup toolchain link succinct "$sp1_rust_dir"
export PATH="$sp1_bin_dir:$PATH"
sp1_cli_version="$(cargo prove --version)"
sp1_rust_version="$(rustc +succinct --version)"
[[ "$sp1_cli_version" == *cfb5544* ]]
[[ "$sp1_rust_version" == 'rustc 1.94.0-dev' || "$sp1_rust_version" == 'rustc 1.94.0-dev '* ]]
printf '%s\n' "$sp1_cli_version" "$sp1_rust_version"
printf '%s\n' "$sp1_bin_dir" >> "${GITHUB_PATH:?}"
