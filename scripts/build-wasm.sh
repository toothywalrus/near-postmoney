#!/bin/sh
# Rebuild both contracts and copy them to res/ with their SHA-256 sums. A judge doesn't need this: res/*.wasm is
# checked in. Uses the host's cargo-near if it has one (Rust 1.86 per contracts/rust-toolchain.toml, cargo-near 0.23),
# otherwise the judge-full Docker image (Rust 1.86, cargo-near 0.23) with a shared registry volume.
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD='set -e; for c in postmoney test-usdc; do (cd $c && cargo near build non-reproducible-wasm --locked --no-abi > /tmp/build-$c.log 2>&1 || { cat /tmp/build-$c.log; exit 1; }); done'
if command -v cargo >/dev/null 2>&1 && cargo near --version >/dev/null 2>&1; then
  (cd contracts && sh -c "$BUILD")
else
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_HOME=/usr/local/cargo -e CARGO_TARGET_DIR=/repo/contracts/target \
    -v "$ROOT":/repo -v near-r9-cargo-registry:/usr/local/cargo/registry -w /repo/contracts judge-full:latest sh -c "$BUILD"
fi
mkdir -p res
cp contracts/target/near/postmoney/postmoney.wasm res/postmoney.wasm
cp contracts/target/near/test_usdc/test_usdc.wasm res/test_usdc.wasm
(cd res && sha256sum postmoney.wasm test_usdc.wasm sputnikdao2-ZGdM2TFd.wasm > SHA256SUMS)
ls -la res
