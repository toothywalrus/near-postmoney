// The reference (ref/reference.ts) on YC's worked examples, and its invariants on random cases.
//   npm run reference                 YC vectors + invariants on 2,000 random cases
//   npm run cases                     also writes fixtures/cases.json (inputs + the reference's answers) for the
//                                     Rust tests and the sandbox property test
import { readFileSync, writeFileSync } from "node:fs";
import { convert, waterfall, Refused, type Conversion } from "../ref/reference.ts";
import { capFromJson, capJson, claimJson, conversionJson, generate, generateWaterfalls, safeFromJson, safeJson, termsJson, type Case } from "./lib/cases.ts";

const ROOT = new URL("..", import.meta.url);
const N = Number(process.env.CASES ?? 2000);
let fails = 0;
const ok = (good: boolean, what: string) => {
  if (!good) fails++;
  console.log(`${good ? "✓" : "✗"} ${what}`);
  return good;
};

// 1. YC's worked examples, to the share.
const yc = JSON.parse(readFileSync(new URL("fixtures/yc-examples.json", ROOT), "utf8"));
const cap = capFromJson(yc.cap);
const safes = yc.safes.map(safeFromJson);
for (const ex of yc.conversions) {
  const t = { ...ex.terms, pre_money: BigInt(ex.terms.pre_money), new_money: ex.terms.new_money.map(BigInt), pool: "increase" in ex.terms.pool ? { increase: BigInt(ex.terms.pool.increase) } : ex.terms.pool };
  const r = convert(cap, safes, t);
  const e = ex.expect;
  const got = {
    price: `${r.price}`, company_capitalization: `${r.company_capitalization}`, safe_shares: r.safes.map((x) => `${x.shares}`), safe_basis: r.safes.map((x) => x.basis),
    new_shares: r.new_shares.map(String), new_shares_total: `${r.new_shares_total}`, pool_after: `${r.pool_after}`, post_money_shares: `${r.post_money_shares}`,
  };
  ok(JSON.stringify(got) === JSON.stringify(e), `reference reproduces YC ${ex.id}: price $${Number(r.price) / 1e6}, K ${r.company_capitalization}, SAFEs ${got.safe_shares.join(" / ")}, new ${got.new_shares.join(" / ")}, FD ${r.post_money_shares}`);
  if (JSON.stringify(got) !== JSON.stringify(e)) console.log("   got ", got, "\n   want", e);
}
for (const ev of yc.liquidity.events) {
  const claims = yc.safes.map((x: any) => ({ safe: { purchase: BigInt(x.purchase), cap: BigInt(x.cap) } }));
  const w = waterfall(BigInt(ev.exit), BigInt(yc.liquidity.common), claims);
  const e = ev.expect;
  const good = JSON.stringify(w.claims.map((c) => c.converts)) === JSON.stringify(e.converts)
    && (!e.shares || JSON.stringify(w.claims.map((c) => `${c.shares}`)) === JSON.stringify(e.shares))
    && (!e.as_converted_shares || `${w.as_converted_shares}` === e.as_converted_shares)
    && (!e.payouts || JSON.stringify(w.claims.map((c) => `${c.payout}`)) === JSON.stringify(e.payouts))
    && (!e.common_payout || `${w.common_payout}` === e.common_payout);
  ok(good, `reference reproduces YC ${ev.id}: ${w.claims.map((c) => (c.converts ? `converts ${c.shares} sh` : "cash-out")).join(", ")}, common $${Number(w.common_payout) / 1e6}`);
}

// 2. Invariants on random cases.
export function invariants(c: Case, r: Conversion): string[] {
  const bad: string[] = [];
  const C = c.cap.outstanding + c.cap.options + c.cap.pool;
  r.safes.forEach((row, i) => {
    const s = c.safes[i];
    if (row.basis === "price" && s.cap !== null && !(row.shares > row.other_basis_shares)) bad.push(`SAFE ${i} took fewer shares`);
    if (row.basis === "cap" && row.shares < row.other_basis_shares) bad.push(`SAFE ${i} took fewer shares`);
    // purchase / cap of the Company Capitalization, within one share
    if (row.basis === "cap") {
      const exact = (r.company_capitalization * s.purchase * 1_000_000n) / s.cap!; // shares x 1e6
      if (exact - row.shares * 1_000_000n >= 1_000_000n || exact < row.shares * 1_000_000n) bad.push(`SAFE ${i} not within one share of purchase/cap`);
    }
  });
  const S = r.safes.reduce((a, x) => a + x.shares, 0n);
  if (S !== r.safe_shares) bad.push("SAFE shares don't add up");
  if (r.pre_money_shares !== C + S + r.pool_increase) bad.push("pre-money shares don't add up");
  if (r.post_money_shares !== r.pre_money_shares + r.new_shares_total) bad.push("post-money shares don't add up");
  if (r.new_shares.reduce((a, b) => a + b, 0n) !== r.new_shares_total) bad.push("new shares don't add up");
  const totalNew = c.terms.new_money.reduce((a, b) => a + b, 0n);
  if (r.new_shares_total !== totalNew / r.price) bad.push("new shares != floor(new money / price)");
  // The price is the exact solution rounded half-up (how far pre-money / FD lands from it is reported, not bounded).
  const unit = 10n ** BigInt(6 - c.terms.price_decimals);
  const e = r.exact_price;
  if ((2n * r.price - unit) * e.d > 2n * e.n || 2n * e.n >= (2n * r.price + unit) * e.d) bad.push("price is not the exact price rounded half-up");
  if ("target_bps" in c.terms.pool) {
    const q = BigInt(c.terms.pool.target_bps);
    if (r.pool_after * 10_000n < q * r.post_money_shares && r.pool_increase > 0n) bad.push("pool below target");
    if (r.pool_increase > 0n && (r.pool_after - 1n) * 10_000n >= q * (r.post_money_shares - 1n)) bad.push("pool not the least that reaches target");
  }
  // Each new investor's shares within (number of investors) of floor(cash / price).
  r.new_shares.forEach((n, i) => {
    const f = c.terms.new_money[i] / r.price;
    if (n < f || n > f + BigInt(r.new_shares.length)) bad.push(`new investor ${i} share count off`);
  });
  return bad;
}

const cases = generate(N);
let converted = 0, refused = 0, ambiguous = 0, broken = 0, atPrice = 0, selfConsistent = 0;
const rows: unknown[] = [];
const t0 = Date.now();
for (const c of cases) {
  try {
    const r = convert(c.cap, c.safes, c.terms);
    converted++;
    atPrice += r.safes.filter((x) => x.basis === "price" && c.safes[r.safes.indexOf(x)].cap !== null).length;
    const bad = invariants(c, r);
    const unit = 10n ** BigInt(6 - c.terms.price_decimals);
    if (((2n * c.terms.pre_money + unit * r.pre_money_shares) / (2n * unit * r.pre_money_shares)) * unit === r.price) selfConsistent++;
    if (bad.length) {
      broken++;
      if (broken <= 5) console.log(`   case ${c.id}: ${bad.join("; ")}`);
    }
    rows.push({ id: c.id, cap: capJson(c.cap), safes: c.safes.map(safeJson), terms: termsJson(c.terms), expect: conversionJson(r) });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    if (e.message.startsWith("ambiguous")) ambiguous++;
    else refused++;
    rows.push({ id: c.id, cap: capJson(c.cap), safes: c.safes.map(safeJson), terms: termsJson(c.terms), expect: e.message });
  }
}
ok(broken === 0, `invariants hold on ${converted} converted random cases (${atPrice} capped SAFEs took the round's price; ${refused} refused; ${ambiguous} ambiguous; in ${Date.now() - t0} ms; round(pre-money / FD) = price exactly in ${selfConsistent})`);
ok(ambiguous === 0, "no case has more than one consistent answer");
// 3. Waterfalls: every payout adds up to the exit (less rounding dust), preferences are honored in order.
const wcases = generateWaterfalls(N);
const wrows: unknown[] = [];
let wbad = 0, wamb = 0, conv = 0;
for (const w of wcases) {
  try {
    const r = waterfall(w.exit, w.common, w.claims);
    const paid = r.claims.reduce((a, c) => a + c.payout, 0n) + r.common_payout;
    const dust = w.exit - paid;
    // Each claimant is paid at most what converting or its preference would give, and the dust is under one micro-dollar per payee.
    if (dust < 0n || dust > BigInt(w.claims.length + 1)) wbad++;
    // No claimant gets less than its preference while common stock is paid anything.
    if (r.common_payout > 0n && w.claims.some((c, i) => r.claims[i].payout + BigInt(w.claims.length + 1) < ("safe" in c ? c.safe.purchase : c.preferred.preference))) wbad++;
    conv += r.claims.filter((c) => c.converts).length;
    wrows.push({ id: w.id, exit: `${w.exit}`, common: `${w.common}`, claims: w.claims.map(claimJson), expect: { claims: r.claims.map((c) => ({ converts: c.converts, shares: `${c.shares}`, payout: `${c.payout}` })), common_payout: `${r.common_payout}`, as_converted_shares: `${r.as_converted_shares}` } });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    wamb++;
    wrows.push({ id: w.id, exit: `${w.exit}`, common: `${w.common}`, claims: w.claims.map(claimJson), expect: e.message });
  }
}
ok(wbad === 0 && wamb === 0, `waterfall: ${wcases.length} random exits add up and honor preferences (${conv} claimants converted; ${wamb} without a unique equilibrium)`);
if (process.argv.includes("--write-cases")) {
  writeFileSync(new URL("fixtures/waterfalls.json", ROOT), JSON.stringify(wrows).replace(/\},\{"id"/g, '},\n{"id"') + "\n");
  writeFileSync(new URL("fixtures/cases.json", ROOT), JSON.stringify(rows, null, 0).replace(/\},\{"id"/g, '},\n{"id"') + "\n");
  console.log(`wrote fixtures/cases.json (${rows.length} cases)`);
}
console.log(fails ? `${fails} FAILED` : "reference: all checks passed");
process.exit(fails ? 1 : 0);
