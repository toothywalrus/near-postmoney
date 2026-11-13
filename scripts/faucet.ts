// One account from the public testnet faucet (no sign-up); its key goes to the OS keyring (service
// near-lab-testnet) BEFORE the faucet is asked, and is read back, so a key can't be lost after a draw.
//   npm run faucet -- --probe          only the keyring round-trip (store, read back, clear a throwaway)
//   npm run faucet -- <name>.testnet   one draw
// (Copied from near-proof-of-capture's cli/src/faucet.ts, MIT, our own repo; only the import of `exists` changed.)
import { KeyPair } from "near-api-js";
import { randomBytes } from "node:crypto";
import { BACKEND, keychainDelete, keychainHas, keychainLoad, keychainSet } from "./lib/keys.ts";
import { Chain } from "./lib/near.ts";

const chain = new Chain(process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com");
// A key kept in this process only would be lost when it exits, and with it the account: refuse first.
if (BACKEND === "memory") { console.error("refused: no OS keyring here (macOS keychain or secret-tool), so the new key would be lost"); process.exit(1); }
function roundTrip(account: string, value: string): boolean {
  keychainSet(account, value);
  return keychainLoad(account) === value;
}
if (process.argv[2] === "--probe") {
  const probe = `keyring-probe-${randomBytes(4).toString("hex")}.invalid`;
  const ok = roundTrip(probe, `throwaway-${randomBytes(8).toString("hex")}`);
  keychainDelete(probe);
  const gone = !keychainHas(probe);
  console.log(`keyring (${BACKEND}): store + read back ${ok ? "OK" : "FAILED"}, clear ${gone ? "OK" : "FAILED"}`);
  process.exit(ok && gone ? 0 : 1);
}
const id = process.argv[2];
if (!id?.endsWith(".testnet")) { console.error("usage: npm run faucet -- <name>.testnet"); process.exit(2); }
if (await chain.exists(id)) { console.error(`refused: ${id} exists already`); process.exit(1); }
const key = KeyPair.fromRandom("ed25519");
if (!roundTrip(id, key.toString())) { console.error(`refused: the key for ${id} did not read back from the keyring (${BACKEND}); no draw made`); process.exit(1); }
const FAUCET = process.env.FAUCET ?? "https://helper.nearprotocol.com/account";
const res = await fetch(FAUCET, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }) });
if (!res.ok) { console.error(`faucet refused ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)} (its unused key stays in the keyring)`); process.exit(1); }
console.log(`created ${id}; its key was in the keyring (${BACKEND}) before the draw, read back`);
