// Re-read the testnet deployment from chain state (views and transaction status only: free, no keys).
//   npm run verify
// Exits 3 (SKIP in npm run judge) if no testnet RPC answers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { baseEncode } from "near-api-js";
import { Checks, rpcOk } from "./lib/verify-util.ts";
import { COMPANY, DAO, FUNDER, testnet, USDC } from "./lib/testnet.ts";

const chain = testnet();
const c = new Checks();
if (!(await rpcOk(chain))) {
  console.log("SKIP: no testnet RPC answered");
  process.exit(3);
}
const ROOT = new URL("..", import.meta.url);
const res = (f: string) => readFileSync(new URL(`res/${f}`, ROOT));
const hash = (b: Buffer) => baseEncode(createHash("sha256").update(b).digest());
const run = JSON.parse(readFileSync(new URL("deploy/testnet-run.json", ROOT), "utf8"));
const yc = JSON.parse(readFileSync(new URL("fixtures/yc-examples.json", ROOT), "utf8"));
const v = <T = any>(m: string, a: Record<string, unknown> = {}) => chain.view<T>(COMPANY, m, a);
async function rpc(method: string, params: unknown): Promise<any> {
  for (const url of [chain.rpc, "https://near-testnet.drpc.org"]) {
    const j = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).catch(() => null);
    if (j?.result) return j.result;
  }
  throw new Error(`${method}: no answer`);
}

c.section("Code and ownership");
const acct = async (id: string) => chain.provider.viewAccount({ accountId: id });
const [a, u, d] = await Promise.all([acct(COMPANY), acct(USDC), acct(DAO)]);
c.check(a.code_hash === hash(res("postmoney.wasm")), `${COMPANY} runs res/postmoney.wasm`, a.code_hash);
c.check(u.code_hash === hash(res("test_usdc.wasm")), `${USDC} runs res/test_usdc.wasm (TEST TOKEN, no value)`, u.code_hash);
c.check(d.code_hash === hash(res("sputnikdao2-ZGdM2TFd.wasm")), `${DAO} runs the code sputnik-v2.testnet deploys (ZGdM2TFd…)`, d.code_hash);
const meta = await chain.view<any>(USDC, "ft_metadata");
c.check(meta.symbol === "tUSDC-TEST" && meta.name.includes("TEST"), "the token says it is a test token", `${meta.name} / ${meta.symbol}`);
const t = await v("cap_table");
c.check(t.board === DAO && t.treasury === DAO && t.usdc === USDC, "the cap table's board and treasury are the DAO; it takes only the test USDC");
const policy = await chain.view<any>(DAO, "get_policy");
const council = policy.roles.find((r: any) => r.name === "council")?.kind?.Group ?? [];
c.check(council.length === 3 && JSON.stringify(policy.default_vote_policy.threshold) === "[1,2]", "the DAO's council: 3 members, more than half to pass", council.map((x: string) => x.split(".")[0]).join(", "));
const keys = (await chain.provider.viewAccessKeyList({ accountId: COMPANY })).keys.length;
c.check(true, `the cap table account has ${keys} access key(s)${keys ? " (not locked yet: npm run lock deletes them)" : " (locked: nobody can change its code)"}`);

c.section("The Series A, as executed, against YC's guide");
const pr = (await v<any[]>("priced_rounds")).find((r) => r.name === "Series A");
const p = pr && JSON.parse(pr.preview);
const e = yc.conversions[0].expect;
c.check(!!p && p.price === e.price && p.conversion.company_capitalization === e.company_capitalization, "price $1.1144, Company Capitalization 11,764,705", p && `${p.price} ${p.conversion.company_capitalization}`);
c.check(!!p && JSON.stringify(p.safes.map((s: any) => s.shares)) === JSON.stringify(e.safe_shares) && JSON.stringify(p.investors.map((i: any) => i.shares)) === JSON.stringify(e.new_shares), "SAFEs 588,235 and 1,176,470; new money 3,589,375 / 448,671 / 448,673", p && `${p.safes.map((s: any) => s.shares)} | ${p.investors.map((i: any) => i.shares)}`);
c.check(!!p && p.conversion.post_money_shares === e.post_money_shares && p.conversion.new_shares_total === e.new_shares_total, "4,486,719 Series A shares; 17,946,424 fully diluted", p?.conversion.post_money_shares);
const holds = (who: string, cls: string) => t.positions.find((x: any) => x.holder === `${who}.${FUNDER}` && t.classes[x.class].name === cls)?.shares;
c.check(holds("alice", "Series A-1 (Safe Preferred)") === "588235" && holds("bob", "Series A-2 (Safe Preferred)") === "1176470" && holds("bob", "Series A") === "448671" && holds("carol", "Series A") === "3589375" && holds("dave", "Series A") === "448673", "the positions on chain: alice A-1 588,235; bob A-2 1,176,470 and Series A 448,671; carol 3,589,375; dave 448,673");

c.section("The board's record");
const proposals = await chain.view<any[]>(DAO, "get_proposals", { from_index: 0, limit: 100 });
c.check(proposals.length >= 9 && proposals.every((x) => x.status === "Approved"), `${proposals.length} proposals, every one approved by the council`);
const staleStep = run.steps.find((s: any) => s.proposal === run.staleDone?.proposal && /votes/.test(s.what));
if (staleStep) {
  const voter = `${staleStep.what.trim().split(" ")[0]}.${FUNDER}`;
  const st = await rpc("EXPERIMENTAL_tx_status", { tx_hash: staleStep.tx, sender_account_id: voter, wait_until: "FINAL" }).catch(() => null);
  const failure = JSON.stringify(st?.receipts_outcome?.map((o: any) => o.outcome.status?.Failure).filter(Boolean) ?? "");
  c.check(failure.includes("changed since the preview"), `proposal ${run.staleDone.proposal} (the stale preview's hash) passed its vote and the cap table refused it in that transaction`, staleStep.tx);
}
c.check(t.version !== undefined && (await v<any[]>("priced_rounds")).length === 1, "exactly one priced round executed (the stale one converted nothing)");

c.section("Money and certificates");
const treasury = BigInt(await chain.view<string>(USDC, "ft_balance_of", { account_id: DAO }));
c.check(treasury === 1_120_000_000_000n, "the treasury (the DAO) holds $1,120,000 tUSDC: $1m + $50k + $100k raised, less the $30k it paid to buy shares back", `${Number(treasury) / 1e6}`);
const escrow = BigInt(await chain.view<string>(USDC, "ft_balance_of", { account_id: COMPANY }));
c.check(escrow === 0n, "nothing is left in the cap table's escrow");
const offers = await v<any[]>("offers");
c.check(offers[0]?.status === "Settled" && offers[1]?.status === "Matched" && t.positions.some((x: any) => x.holder === DAO && x.shares === "50000"), "secondary sales: one settled after the window, one bought by the company (it holds 50,000 shares)");
const supply = await v("nft_total_supply");
const t3 = await v("nft_token", { token_id: "3" });
c.check(supply === "2" && JSON.parse(t3.metadata.extra).amended_from_round === 2 && JSON.parse(t3.metadata.extra).cap === "30000000000000", "2 SAFE certificates outstanding; #3 is the MFN SAFE amended to the bridge round's $30m cap and 20% discount", t3.metadata.title);

c.section("The deployed wasm on YC's examples (free views)");
for (const ex of yc.conversions) {
  const r = await v("simulate_conversion", { cap: yc.cap, safes: yc.safes.map(({ who, ...s }: any) => s), terms: ex.terms });
  c.check(r.price === ex.expect.price && JSON.stringify(r.new_shares) === JSON.stringify(ex.expect.new_shares) && r.post_money_shares === ex.expect.post_money_shares, `testnet's contract reproduces YC ${ex.id.split(":")[0]}`);
}
console.log(`\n${c.count - c.fails}/${c.count} chain checks passed`);
process.exit(c.fails ? 1 : 0);
