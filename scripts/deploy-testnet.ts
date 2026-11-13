// The owner's tool, run once: put Postmoney on testnet from one faucet account.   npm run deploy
//   usdc.<funder>                     the TEST USDC (no value), res/test_usdc.wasm
//   acme.<funder>                     Acme Robotics' cap table, res/postmoney.wasm, owned by the DAO
//   acme-board-<x>.sputnik-v2.testnet the board: a Sputnik DAO made by the testnet factory, council ada, ben, erin
//   ada, ben, erin, alice, bob, carol, dave .<funder>   the people, each with a little NEAR for gas
// Every key goes to the OS keyring before the account exists. Safe to run again: each step is skipped once done.
// Refuses wasm whose SHA-256 differs from res/SHA256SUMS.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actions, baseEncode, KeyPair, nearToYocto } from "near-api-js";
import { keychainSet } from "./lib/keys.ts";
import { call, milli, NEAR, TGAS } from "./lib/near.ts";
import { COMPANY, DAO, FACTORY, FUNDER, PEOPLE, person, testnet, USDC } from "./lib/testnet.ts";

const chain = testnet();
const res = (f: string) => readFileSync(new URL(`../res/${f}`, import.meta.url));
const sums = Object.fromEntries(res("SHA256SUMS").toString().trim().split("\n").map((l: string) => l.split(/\s+/).reverse()));
for (const f of ["postmoney.wasm", "test_usdc.wasm"]) {
  const got = createHash("sha256").update(res(f)).digest("hex");
  if (got !== sums[f]) throw new Error(`${f}: sha256 ${got} does not match res/SHA256SUMS`);
}
const funder = chain.account(FUNDER);
const near = (y: bigint) => `${(Number(y) / 1e24).toFixed(4)} NEAR`;
console.log(`funder ${FUNDER}: ${near(await chain.balance(FUNDER))}`);
const must = (r: { ok: boolean; reason?: string; tx?: string }, what: string) => {
  if (!r.ok) throw new Error(`${what}: ${r.reason} ${chain.txLink(r.tx)}`);
  console.log(`${what}: ${chain.txLink(r.tx)}`);
  return r;
};

// 1. People. Board members vote with up to 300 TGas (0.03 NEAR prepaid), so they get a little more.
const gas: Record<string, string> = { ada: "0.07", ben: "0.07", erin: "0.05", alice: "0.04", bob: "0.04", carol: "0.035", dave: "0.035" };
for (const n of PEOPLE) {
  const id = person(n);
  if (await chain.exists(id)) continue;
  const key = KeyPair.fromRandom("ed25519");
  keychainSet(id, key.toString());
  const r = await funder.signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(nearToYocto(gas[n] as `${number}`)), actions.addFullAccessKey(key.getPublicKey())], waitUntil: "FINAL" } as any);
  console.log(`${id}: created with ${gas[n]} NEAR ${chain.txLink(r.transaction.hash)}`);
}

// 2. Contracts: created, funded for their code plus a little state, deployed and initialised in one transaction.
//    Each keeps a full-access key (in the keyring) until `npm run lock` deletes it.
async function born(id: string, code: Buffer, init: Record<string, unknown>, stateBytes: number) {
  if (await chain.exists(id)) return console.log(`${id} exists`);
  const key = KeyPair.fromRandom("ed25519");
  keychainSet(id, key.toString());
  const amount = BigInt(code.length + stateBytes) * 10n ** 19n;
  const r = await funder.signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(key.getPublicKey()), actions.deployContract(code), actions.functionCall("new", init, 50n * TGAS, 0n)],
    waitUntil: "FINAL",
  } as any);
  console.log(`${id}: ${near(amount)}, ${code.length} bytes deployed and initialised ${chain.txLink(r.transaction.hash)}`);
}
await born(USDC, res("test_usdc.wasm"), {}, 2000);

// 3. The board: a Sputnik DAO from the testnet factory. More than half the council (2 of 3) passes a proposal.
if (!(await chain.exists(DAO))) {
  const policy = {
    roles: [{ name: "council", kind: { Group: [person("ada"), person("ben"), person("erin")] }, permissions: ["*:*"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: milli(10).toString(),
    proposal_period: (7n * 24n * 3600n * 10n ** 9n).toString(),
    bounty_bond: milli(10).toString(),
    bounty_forgiveness_period: (24n * 3600n * 10n ** 9n).toString(),
  };
  const name = DAO.split(".")[0];
  const config = { name, purpose: "The board of Acme Robotics, Inc. (a demo company on testnet): it owns the cap table at " + COMPANY, metadata: "" };
  const args = Buffer.from(JSON.stringify({ config, policy })).toString("base64");
  must(await call(funder, FACTORY, "create", { name, args }, nearToYocto((process.env.DAO_NEAR ?? "4.85") as `${number}`), 300n), `DAO ${DAO} created by ${FACTORY}`);
}

// 4. The cap table: owned by the DAO, the DAO is its treasury. YC's Example 1 company.
await born(COMPANY, res("postmoney.wasm"), {
  owner_id: DAO,
  company: "Acme Robotics, Inc.",
  usdc: USDC,
  treasury: DAO,
  founders: [{ account: person("ada"), shares: "6000000" }, { account: person("ben"), shares: "3250000" }],
  options: "650000",
  pool: "100000",
  rofr_secs: "120",
}, 5000);

// 4b. While the cap table still has its key (before npm run lock), a newer res/postmoney.wasm replaces its code
//     (same state layout; only the size difference in storage is paid).
{
  const live = (await chain.provider.viewAccount({ accountId: COMPANY })).code_hash;
  const local = baseEncode(createHash("sha256").update(res("postmoney.wasm")).digest());
  if (live !== local) {
    const r = await chain.account(COMPANY).signAndSendTransaction({ receiverId: COMPANY, actions: [actions.deployContract(res("postmoney.wasm"))], waitUntil: "FINAL" } as any);
    console.log(`${COMPANY}: code ${live.slice(0, 8)}… replaced by res/postmoney.wasm ${local.slice(0, 8)}… ${chain.txLink(r.transaction.hash)}`);
  }
}

// 5. The cap table and the DAO can hold test USDC; the board's storage balance on the cap table pays for its actions.
for (const id of [COMPANY, DAO]) {
  const has = await chain.view(USDC, "storage_balance_of", { account_id: id });
  if (!has) must(await call(funder, USDC, "storage_deposit", { account_id: id }, 1_250_000_000_000_000_000_000n), `${id} registered with the test USDC`);
}
if (BigInt(await chain.view(COMPANY, "storage_balance_of", { account_id: DAO })) === 0n) {
  must(await call(funder, COMPANY, "storage_deposit", { account_id: DAO }, NEAR / 10n), "0.1 NEAR of storage balance for the board's actions");
}
console.log(`\nfunder left: ${near(await chain.balance(FUNDER))}`);
for (const id of [USDC, COMPANY, DAO]) console.log(`${id}: ${near(await chain.balance(id))}`);
