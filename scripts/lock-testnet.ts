// The owner's step, when he is satisfied: delete the full-access keys of the cap table and the test token, so nobody
// (the deployer included) can change their code or move their NEAR. The cap table then answers only to its DAO.
// Irreversible.   npm run lock -- --yes
import { actions, KeyPair, type KeyPairString } from "near-api-js";
import { keychainLoad } from "./lib/keys.ts";
import { COMPANY, testnet, USDC } from "./lib/testnet.ts";

if (!process.argv.includes("--yes")) {
  console.log("This deletes the access keys of the cap table and the test token for good. Run: npm run lock -- --yes");
  process.exit(2);
}
const chain = testnet();
for (const id of [COMPANY, USDC]) {
  const keys = (await chain.provider.viewAccessKeyList({ accountId: id })).keys;
  if (!keys.length) {
    console.log(`${id}: already locked (no access keys)`);
    continue;
  }
  const mine = KeyPair.fromString(keychainLoad(id) as KeyPairString).getPublicKey();
  const r = await chain.account(id).signAndSendTransaction({ receiverId: id, actions: [actions.deleteKey(mine)], waitUntil: "FINAL" } as any);
  const left = (await chain.provider.viewAccessKeyList({ accountId: id })).keys.length;
  console.log(`${id}: key deleted ${chain.txLink(r.transaction.hash)}; ${left} access key(s) left`);
}
