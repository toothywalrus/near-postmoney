# Instructions for Claude Code

**Postmoney** is a NEAR HACKATHON entry: a company cap table on NEAR whose board is a Sputnik DAO, with post-money SAFE
rounds in USDC (escrow, NEP-171 SAFE certificates), exact conversion at the priced round, an exit waterfall, and
secondary sales with the company's right of first refusal. Built 2026-11-13 from near-lab's
`docs/ideas/postmoney.md`. Read `README.md` (status, claims) and `docs/decisions/` before changing anything.

## Rules that are load-bearing

1. **Testnet only.** Never sign a mainnet transaction. Mainnet is the owner's step, with his own account.
2. **No secrets in git**, not even gitignored. Testnet keys live in the OS keyring (`secret-tool`, service
   `near-lab-testnet`, account = the NEAR account id) via `scripts/lib/keys.ts`. Never list or dump the keyring.
3. **The repo stays private** until the owner makes it public. No judging talk (scores, rubrics) in files or commits.
4. **The conversion's arithmetic is the product.** Any change to `contracts/safe-math` must keep `npm run property`
   (YC's examples to the share, wasm = reference on every number) and `npm run reference` green. The rounding rule is
   decision 0002; change it only with a new decision record.
5. **Rust 1.86 in Docker** (`judge-full:latest`; no Rust on the host). `npm run build:contracts` rebuilds `res/*.wasm`
   and `res/SHA256SUMS`; then `npm run mutants -- --build` (the mutants must come from the same source) and redeploy
   with `npm run deploy` (it replaces the cap table's code while its key exists).

## Layout

- `contracts/safe-math` (pure math, no near-sdk), `contracts/postmoney` (`lib.rs` state and calls, `views.rs`),
  `contracts/test-usdc` (macro-free NEP-141 test token, decision 0006).
- `ref/reference.ts`: the independent reference. Never import contract code into it or it into the contract.
- `scripts/`: `judge.ts`, `reference-check.ts`, `property.ts`, `sandbox.ts`, `attacks.ts`, `mutants.ts` (sandbox, no
  keys); `deploy-testnet.ts`, `demo-testnet.ts`, `lock-testnet.ts` (sign with keyring keys); `verify.ts`,
  `snapshot.ts` (views only); `shots.ts` (Playwright).
- `deploy/testnet-run.json`: every testnet transaction of the demo. `web/`: the page; `web/public/snapshot.json` and
  `run.json` are refreshed by `npm run snapshot`.

## Testnet

Funder `near-postmoney-8624.testnet` (one faucet draw, ~0.57 NEAR left). Cap table `acme.<funder>`, token
`usdc.<funder>`, board `acme-board-8624.sputnik-v2.testnet` (council ada, ben, erin `.<funder>`). Testnet charges
prepaid gas up front at ~0.001 NEAR per TGas; `demo-testnet.ts` lends the people what a call needs. This Sputnik
version marks a proposal Approved even when its call fails: read the receipts, not the status.

## Issue tracking / decision records

Decision records in `docs/decisions/` (index in its README). Issues: none filed yet; the convention is near-lab's
(`~/dev/claude-conventions/project-memory-system.md`).
