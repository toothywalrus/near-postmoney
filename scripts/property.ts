// The kill test, on the contract itself: res/postmoney.wasm (the wasm testnet runs) on a local sandbox, its
// stateless views `simulate_conversion` and `simulate_waterfall` against the independent reference (ref/reference.ts).
//   npm run property                 YC's worked examples, the 2,000 + 2,000 fixture cases, and 500 fresh random rounds
//   SEED=9 FRESH=3000 npm run property   more fresh cases from another seed
// Every number must be equal: price, Company Capitalization, each SAFE's shares and basis, the pool, every new
// investor's shares, the totals; and every waterfall choice and payout. A case one side refuses, the other must too.
import { readFileSync } from "node:fs";
import { actions } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { convert, Refused, waterfall } from "../ref/reference.ts";
import { capJson, claimJson, conversionJson, generate, generateWaterfalls, safeJson, termsJson } from "./lib/cases.ts";
import { Chain, Checks, TGAS } from "./lib/near.ts";
import { finish, stopSandbox, wasm } from "./lib/world.ts";

const ROOT = new URL("..", import.meta.url);
const FRESH = Number(process.env.FRESH ?? 500);
const SEED = Number(process.env.SEED ?? 7);
const c = new Checks();
const t0 = Date.now();
const sandbox = await Sandbox.start({});
const chain = new Chain(sandbox.rpcUrl);
chain.remember(DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY);
const root = chain.account(DEFAULT_ACCOUNT_ID);
const calc = await chain.subAccount(root, "calc", "20");
await calc.signAndSendTransaction({
  receiverId: calc.accountId,
  actions: [actions.deployContract(wasm("postmoney.wasm")), actions.functionCall("new", { owner_id: root.accountId, company: "Calculator", usdc: root.accountId, treasury: root.accountId, founders: [{ account: root.accountId, shares: "1" }], options: "0", pool: "0", rofr_secs: null }, 100n * TGAS, 0n)],
  waitUntil: "FINAL",
});
console.log(`sandbox up, res/postmoney.wasm deployed (${Math.round((Date.now() - t0) / 1000)} s)`);

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}
const pick = (o: any) => conversionJson({ ...o, safes: o.safes.map((s: any) => ({ ...s, shares: BigInt(s.shares), other_basis_shares: BigInt(s.other_basis_shares) })), new_shares: o.new_shares.map(BigInt), ...Object.fromEntries(["price", "company_capitalization", "safe_shares", "pool_increase", "pool_after", "new_shares_total", "pre_money_shares", "post_money_shares"].map((k) => [k, BigInt(o[k])])) });

// 1. YC's worked examples, through the wasm.
const yc = JSON.parse(readFileSync(new URL("fixtures/yc-examples.json", ROOT), "utf8"));
for (const ex of yc.conversions) {
  const r = await chain.tryView<any>(calc.accountId, "simulate_conversion", { cap: yc.cap, safes: yc.safes.map(({ who, ...s }: any) => s), terms: ex.terms });
  const e = ex.expect;
  const got = r.ok && {
    price: r.value.price, company_capitalization: r.value.company_capitalization, safe_shares: r.value.safes.map((s: any) => s.shares), safe_basis: r.value.safes.map((s: any) => s.basis),
    new_shares: r.value.new_shares, new_shares_total: r.value.new_shares_total, pool_after: r.value.pool_after, post_money_shares: r.value.post_money_shares,
  };
  c.check(JSON.stringify(got) === JSON.stringify(e), `wasm reproduces YC ${ex.id} to the share`, r.ok ? `price $${Number(r.value.price) / 1e6}, SAFEs ${got && got.safe_shares.join(" / ")}, new ${got && got.new_shares.join(" / ")}` : r.reason);
}
for (const ev of yc.liquidity.events) {
  const claims = yc.safes.map((s: any) => ({ safe: { purchase: s.purchase, cap: s.cap } }));
  const r = await chain.tryView<any>(calc.accountId, "simulate_waterfall", { exit: ev.exit, common: yc.liquidity.common, claims });
  const e = ev.expect;
  const good = r.ok && JSON.stringify(r.value.claims.map((x: any) => x.converts)) === JSON.stringify(e.converts)
    && (!e.shares || JSON.stringify(r.value.claims.map((x: any) => x.shares)) === JSON.stringify(e.shares))
    && (!e.as_converted_shares || r.value.as_converted_shares === e.as_converted_shares)
    && (!e.payouts || JSON.stringify(r.value.claims.map((x: any) => x.payout)) === JSON.stringify(e.payouts))
    && (!e.common_payout || r.value.common_payout === e.common_payout);
  c.check(!!good, `wasm reproduces YC ${ev.id}`, r.ok ? r.value.claims.map((x: any) => (x.converts ? `converts ${x.shares} shares` : "cash-out")).join(", ") : r.reason);
}

// 2. Conversions: the fixture's 2,000, then fresh ones checked against the reference here.
type Row = { id: number | string; cap: any; safes: any; terms: any; expect: any };
const fixture: Row[] = JSON.parse(readFileSync(new URL("fixtures/cases.json", ROOT), "utf8"));
const fresh: Row[] = generate(FRESH, SEED * 7919).map((k) => {
  let expect: any;
  try {
    expect = conversionJson(convert(k.cap, k.safes, k.terms));
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    expect = e.message;
  }
  return { id: `fresh-${k.id}`, cap: capJson(k.cap), safes: k.safes.map(safeJson), terms: termsJson(k.terms), expect };
});
let agree = 0, bothRefuse = 0, disagree = 0, priceBasis = 0, safesSeen = 0;
const t1 = Date.now();
await pool([...fixture, ...fresh], 24, async (row) => {
  const r = await chain.tryView<any>(calc.accountId, "simulate_conversion", { cap: row.cap, safes: row.safes, terms: row.terms });
  if (typeof row.expect === "string") {
    if (!r.ok) bothRefuse++;
    else if (++disagree <= 5) console.log(`  ✗ case ${row.id}: reference refused (${row.expect}), wasm converted`);
    return;
  }
  if (!r.ok) {
    if (++disagree <= 5) console.log(`  ✗ case ${row.id}: wasm refused: ${r.reason}`);
    return;
  }
  const got = pick(r.value);
  const want = row.expect;
  const same = JSON.stringify(got) === JSON.stringify(Object.fromEntries(Object.keys(got).map((k) => [k, want[k]])));
  if (same) {
    agree++;
    safesSeen += got.safes.length;
    priceBasis += got.safes.filter((s: any, i: number) => s.basis === "price" && row.safes[i].cap !== null).length;
  } else if (++disagree <= 5) console.log(`  ✗ case ${row.id}: got ${JSON.stringify(got).slice(0, 300)}\n    want ${JSON.stringify(want).slice(0, 300)}`);
});
const n = fixture.length + fresh.length;
c.check(disagree === 0, `wasm = reference on ${n} random priced rounds: ${agree} converted identically (${safesSeen} SAFEs, ${priceBasis} capped ones at the round's price), ${bothRefuse} refused by both`, `${disagree} disagree; ${Math.round((Date.now() - t1) / 1000)} s`);

// 3. Waterfalls.
const wfix: any[] = JSON.parse(readFileSync(new URL("fixtures/waterfalls.json", ROOT), "utf8"));
const wfresh = generateWaterfalls(FRESH, SEED * 104729).map((w) => {
  let expect: any;
  try {
    const r = waterfall(w.exit, w.common, w.claims);
    expect = { claims: r.claims.map((x) => ({ converts: x.converts, shares: `${x.shares}`, payout: `${x.payout}` })), common_payout: `${r.common_payout}`, as_converted_shares: `${r.as_converted_shares}` };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    expect = e.message;
  }
  return { id: `fresh-${w.id}`, exit: `${w.exit}`, common: `${w.common}`, claims: w.claims.map(claimJson), expect };
});
let wagree = 0, wdis = 0, converts = 0;
await pool([...wfix, ...wfresh], 24, async (row) => {
  const r = await chain.tryView<any>(calc.accountId, "simulate_waterfall", { exit: row.exit, common: row.common, claims: row.claims });
  if (typeof row.expect === "string") {
    if (!r.ok) wagree++;
    else if (++wdis <= 5) console.log(`  ✗ waterfall ${row.id}: reference refused, wasm paid out`);
    return;
  }
  const got = r.ok && { claims: r.value.claims, common_payout: r.value.common_payout, as_converted_shares: r.value.as_converted_shares };
  if (got && JSON.stringify(got) === JSON.stringify(row.expect)) {
    wagree++;
    converts += got.claims.filter((x: any) => x.converts).length;
  } else if (++wdis <= 5) console.log(`  ✗ waterfall ${row.id}: ${r.ok ? JSON.stringify(got).slice(0, 200) : r.reason}\n    want ${JSON.stringify(row.expect).slice(0, 200)}`);
});
c.check(wdis === 0, `wasm = reference on ${wfix.length + wfresh.length} random exits: every choice and payout (${converts} conversions)`, `${wdis} disagree`);

await finish(c, `property checks passed (${Math.round((Date.now() - t0) / 1000)} s)`, () => stopSandbox(sandbox));
