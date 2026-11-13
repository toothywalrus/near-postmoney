// Record what the page reads from testnet, for when testnet can't be reached: web/public/snapshot.json.
//   npm run snapshot      (free: views only, no keys)
// The page says plainly when it is showing this file instead of the chain.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { COMPANY, DAO, EXPLORER, testnet, USDC } from "./lib/testnet.ts";

const chain = testnet();
const v = <T = any>(m: string, a: Record<string, unknown> = {}) => chain.view<T>(COMPANY, m, a);
const capTable = await v("cap_table");
const certificates = [];
for (const c of capTable.certificates) certificates.push(await v("nft_token", { token_id: c.token_id }));
const proposals = await chain.view<any[]>(DAO, "get_proposals", { from_index: 0, limit: 100 });
const block: any = await chain.provider.viewBlock({ finality: "final" } as any);
const snap = {
  recorded_at: new Date().toISOString(),
  block: block.header.height,
  explorer: EXPLORER,
  company: COMPANY,
  board: DAO,
  usdc: USDC,
  cap_table: capTable,
  rounds: await v("rounds"),
  offers: await v("offers"),
  priced_rounds: await v("priced_rounds"),
  certificates,
  proposals,
  treasury_usdc: await chain.view<string>(USDC, "ft_balance_of", { account_id: DAO }),
};
mkdirSync(new URL("../web/public/", import.meta.url), { recursive: true });
writeFileSync(new URL("../web/public/snapshot.json", import.meta.url), JSON.stringify(snap, null, 1) + "\n");
const run = new URL("../deploy/testnet-run.json", import.meta.url);
if (existsSync(run)) writeFileSync(new URL("../web/public/run.json", import.meta.url), readFileSync(run));
console.log(`web/public/snapshot.json: block ${snap.block}, ${capTable.positions.length} positions, ${certificates.length} certificates, ${proposals.length} proposals`);
