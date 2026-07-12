#!/usr/bin/env bash
# Free disk space on the deploy host by dropping cargo build artifacts.
# They regrow on the next `cargo build --release` (~1.7G), so run this after
# a deploy or whenever the disk fills. Run as the build user; no sudo needed.
# `cargo clean` resolves the workspace root itself, so this also works when
# the repo is a member of a larger local cargo workspace.
set -euo pipefail
PATH="$HOME/.cargo/bin:$PATH"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "before: $(df -h / | tail -1)"
cargo clean --manifest-path "$repo_root/Cargo.toml"
echo "after:  $(df -h / | tail -1)"
