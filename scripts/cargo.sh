#!/bin/sh
# cargo in contracts/, on the host if it has Rust 1.86, else in the judge-full Docker image (Rust 1.86, cargo-near).
#   sh scripts/cargo.sh test -p safe-math
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
if command -v cargo >/dev/null 2>&1; then
  cd contracts && exec cargo "$@"
fi
exec docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_HOME=/usr/local/cargo -e CARGO_TARGET_DIR=/repo/contracts/target \
  -v "$ROOT":/repo -v near-r9-cargo-registry:/usr/local/cargo/registry -w /repo/contracts judge-full:latest cargo "$@"
