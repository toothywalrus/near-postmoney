# 0006: The testnet demo fits one faucet draw

## Context

The testnet demo gets one public-faucet draw: 10 NEAR. A Sputnik DAO from the factory locks 4.72 NEAR of code
storage. The cap table's wasm is 367 KB (3.67 NEAR). The first test token, written with near-sdk's macro and
serde_json, was 138 KB; the people need NEAR for gas. Testnet charges prepaid gas up front at about 0.001 NEAR per
TGas (measured: a 100 TGas call needs 0.101 NEAR on hand), and refunds what isn't burnt.

## Decision

- **The test token is written without the `#[near]` macro and without serde** (`contracts/test-usdc`): a small JSON
  reader and hand-written JSON, 42 KB. Its behaviour is NEP-141's and NEP-145's; the sandbox suites use it for
  every payment.
- **The cap table drops `serde_json::Value`** for a tiny JSON writer for events, and its callbacks take borsh.
- **The people hold a few hundredths of a NEAR**; before a call that needs more on hand, the deploy script's funder
  lends the difference and takes it back after (`scripts/demo-testnet.ts`).
- **The contracts keep a full-access key** (in the deployer's keyring) so a fix can still be deployed;
  `npm run lock` deletes the keys when the owner is satisfied.

## Consequences

- Spent: DAO 4.85, cap table 3.82, token 0.44, people 0.35; about 0.4 NEAR left (README).
- More NEAR would buy a second company (another 3.8 NEAR) or a locked-from-birth deployment.
