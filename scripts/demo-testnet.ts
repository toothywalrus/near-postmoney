// The owner's tool, run once after npm run deploy: YC's Example 1 company, on testnet, every board step a Sputnik
// proposal that two of three council members approve.   npm run demo
//   1. SAFE rounds at $4m and $8m post-money caps; alice and bob invest test USDC; the board closes them; SAFE NFTs.
//   2. The Series A on YC's terms: a preview; the cap table moves; the stale preview's execution fails on chain;
//      the fresh one executes; the cap table is YC's to the share.
//   3. A secondary sale that settles after the company's window; one the company buys itself (ROFR).
//   4. Bridge SAFEs left outstanding (an MFN SAFE that adopts a later round's terms, and a capped one) for the page.
// Writes deploy/testnet-run.json (transaction links). Each step is skipped if the chain shows it done.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { actions } from "near-api-js";
import { call as rawCall, events, milli, sleep, TGAS, usd, type Result } from "./lib/near.ts";
import { COMPANY, DAO, EXPLORER, FUNDER, person, testnet, USDC } from "./lib/testnet.ts";

const chain = testnet();
const OUT = new URL("../deploy/testnet-run.json", import.meta.url);
mkdirSync(new URL("../deploy/", import.meta.url), { recursive: true });
const run: Record<string, any> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { explorer: EXPLORER, company: COMPANY, board: DAO, usdc: USDC, steps: [] };
const save = () => writeFileSync(OUT, JSON.stringify(run, null, 2) + "\n");
const step = (what: string, r: Result | { ok: boolean; tx?: string; reason?: string }, extra: Record<string, unknown> = {}) => {
  console.log(`${r.ok ? "✓" : "✗"} ${what}${r.tx ? `  ${chain.txLink(r.tx)}` : ""}${r.ok ? "" : `  (${r.reason})`}`);
  run.steps.push({ what, ok: r.ok, tx: r.tx, ...(r.ok ? {} : { reason: r.reason }), ...extra });
  save();
  return r;
};
const must = (what: string, r: Result, extra: Record<string, unknown> = {}) => {
  step(what, r, extra);
  if (!r.ok) throw new Error(`${what}: ${r.reason}`);
  return r;
};
const acct = (n: Parameters<typeof person>[0]) => chain.account(person(n));
// Testnet charges prepaid gas up front at about 0.001 NEAR per TGas (refunded after, less what was burnt), so a 300 TGas
// vote needs 0.3 NEAR on hand. The people hold a few hundredths: before a call, the funder lends what is missing;
// at the end each one sends back all but 0.02 NEAR.
const funder = chain.account(FUNDER);
/** Spendable NEAR: the balance less what its own storage locks; read optimistically so a just-sent bond counts. */
async function available(id: string): Promise<bigint> {
  const a: any = await chain.provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } } as any);
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
}
const UPFRONT_PER_TGAS = 1_010_000_000_000_000_000_000n; // yoctoNEAR, measured: a 100 TGas call costs 0.101 NEAR up front
async function call(who: typeof funder, contract: string, method: string, args: Record<string, unknown>, deposit = 0n, tgas = 30n): Promise<Result> {
  const need = deposit + tgas * UPFRONT_PER_TGAS + milli(15);
  const have = await available(who.accountId);
  if (have >= need) return rawCall(who, contract, method, args, deposit, tgas);
  await funder.signAndSendTransaction({ receiverId: who.accountId, actions: [actions.transfer(need - have)], waitUntil: "FINAL" } as any);
  const r = await rawCall(who, contract, method, args, deposit, tgas);
  // Pay the loan back: everything above what the account held before, less the deposit it attached.
  const back = (await available(who.accountId)) - (have > deposit ? have - deposit : 0n) - milli(1);
  if (back > milli(2)) await who.signAndSendTransaction({ receiverId: FUNDER, actions: [actions.transfer(back)], waitUntil: "FINAL" } as any);
  return r;
}
const [ada, ben, erin, alice, bob, carol, dave] = (["ada", "ben", "erin", "alice", "bob", "carol", "dave"] as const).map(acct);
const view = <T = any>(m: string, a: Record<string, unknown> = {}) => chain.view<T>(COMPANY, m, a);
const usdcOf = async (id: string) => BigInt(await chain.view<string>(USDC, "ft_balance_of", { account_id: id }));
const pay = (who: typeof ada, amount: bigint, msg: Record<string, number>) => call(who, USDC, "ft_transfer_call", { receiver_id: COMPANY, amount: amount.toString(), msg: JSON.stringify(msg) }, 1n, 100n);
let voter = 0;
/** A Sputnik proposal of one or more calls to one receiver: ada proposes and votes, ben or erin casts the second vote. */
async function propose(why: string, calls: { method: string; args: Record<string, unknown>; deposit?: bigint; tgas?: bigint }[], receiver = COMPANY, expectFail = false) {
  const kind = { FunctionCall: { receiver_id: receiver, actions: calls.map((c) => ({ method_name: c.method, args: Buffer.from(JSON.stringify(c.args)).toString("base64"), deposit: (c.deposit ?? 0n).toString(), gas: ((c.tgas ?? 100n) * TGAS).toString() })) } };
  // Resume a proposal this script already made (same description, still in progress) rather than file it twice.
  const open = (await chain.view<any[]>(DAO, "get_proposals", { from_index: 0, limit: 100 })).find((x) => x.description === why && x.status === "InProgress");
  let id: number;
  if (open) {
    id = open.id;
    console.log(`resuming proposal ${id}: ${why}`);
  } else {
    const p = await call(ada, DAO, "add_proposal", { proposal: { description: why, kind } }, milli(10), 20n);
    must(`proposal: ${why}`, p, { proposal: p.value });
    id = p.value as number;
  }
  const votes = open?.votes ?? {};
  if (!votes[ada.accountId]) must(`  ada votes for proposal ${id}`, await call(ada, DAO, "act_proposal", { id, action: "VoteApprove", proposal: kind }, 0n, 50n));
  const second = voter++ % 2 === 0 ? ben : erin;
  const actionGas = calls.reduce((a, c) => a + (c.tgas ?? 100n), 0n);
  const v = await call(second, DAO, "act_proposal", { id, action: "VoteApprove", proposal: kind }, 0n, actionGas + 50n > 300n ? 300n : actionGas + 50n);
  const st = await chain.view<any>(DAO, "get_proposal", { id });
  const ok = st.status === "Approved";
  // This Sputnik version records the vote's outcome (Approved) even when the call it makes fails; what the call did
  // is in the receipts: `v.ok` is false and `v.reason` is the contract's refusal.
  const r = { ...v, ok: expectFail ? !v.ok && !!v.reason : ok && v.ok, reason: v.reason ?? st.status };
  step(`  ${second.accountId.split(".")[0]} votes: proposal ${id} ${st.status}${expectFail ? `; the cap table refuses to execute it: "${v.reason}"` : ""}`, r, { proposal: id, status: st.status, refusal: v.reason });
  if (!r.ok) throw new Error(`proposal ${id}: ${st.status} ${v.reason ?? ""}`);
  return { id, status: st.status, tx: v.tx, reason: v.reason };
}

const rounds = await view<any[]>("rounds");
// 0. Everyone gets test USDC (minting registers them) and the investors and sellers a storage balance.
const mints: [typeof ada, bigint][] = [[alice, usd(350_000)], [bob, usd(900_000)], [dave, usd(60_000)], [carol, usd(40_000)]];
for (const [who, amount] of mints) {
  if ((await usdcOf(who.accountId)) === 0n) must(`${who.accountId.split(".")[0]} mints ${amount / 1_000_000n} test USDC`, await call(who, USDC, "mint", { amount: amount.toString() }, 1_250_000_000_000_000_000_000n, 10n));
}
for (const who of [alice, bob, ada, ben]) {
  if (BigInt(await view("storage_balance_of", { account_id: who.accountId })) === 0n) must(`${who.accountId.split(".")[0]} adds 0.01 NEAR storage balance on the cap table`, await call(who, COMPANY, "storage_deposit", {}, milli(10), 10n));
}
for (const who of [ada, ben]) {
  if (!(await chain.view(USDC, "storage_balance_of", { account_id: who.accountId }))) must(`${who.accountId.split(".")[0]} registers with the test USDC`, await call(who, USDC, "storage_deposit", {}, 1_250_000_000_000_000_000_000n, 10n));
}

// 1. SAFE rounds.
const deadline = String(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
const safeRound = (name: string, cap: bigint | null, min: bigint, max: bigint, o: { discount_bps?: number; mfn?: boolean; pro_rata?: boolean } = {}) =>
  ({ method: "open_round", args: { terms: { name, safe: { cap: cap === null ? null : cap.toString(), discount_bps: o.discount_bps ?? 0, mfn: o.mfn ?? false, pro_rata: o.pro_rata ?? false }, min_raise: min.toString(), max_raise: max.toString(), deadline } }, tgas: 30n });
if (rounds.length === 0) {
  await propose("Open two post-money SAFE rounds: $100k-$200k at a $4m cap; $400k-$800k at an $8m cap with a pro rata side letter", [
    safeRound("Pre-seed SAFE ($4m post-money cap)", usd(4_000_000), usd(100_000), usd(200_000)),
    safeRound("Seed SAFE ($8m post-money cap, pro rata)", usd(8_000_000), usd(400_000), usd(800_000), { pro_rata: true }),
  ]);
}
let rs = await view<any[]>("rounds");
if (rs[0].raised === "0") {
  const b = await usdcOf(alice.accountId);
  const r = must("alice pays $250,000 into the $200k round", await pay(alice, usd(250_000), { invest: 0 }));
  console.log(`   kept $${Number(b - (await usdcOf(alice.accountId))) / 1e6}, returned the rest in the same transaction: ${events(r, "postmoney").map((e) => JSON.stringify(e.data[0])).join(" ")}`);
}
if (rs[1].raised === "0") must("bob pays $800,000 into the $8m round", await pay(bob, usd(800_000), { invest: 1 }));
rs = await view<any[]>("rounds");
if (rs[0].status === "Open") {
  await propose("Close both SAFE rounds: the USDC goes to the treasury (this DAO), each investor gets a SAFE certificate", [
    { method: "close_round", args: { round: 0 }, tgas: 100n },
    { method: "close_round", args: { round: 1 }, tgas: 100n },
  ]);
}

// 2. The Series A, on YC's terms.
const terms = {
  name: "Series A",
  pre_money: usd(15_000_000).toString(),
  investors: [
    { account: person("carol"), cash: usd(4_000_000).toString() },
    { account: person("bob"), cash: "499998970000" },
    { account: person("dave"), cash: "500001030000" },
  ],
  pool: { increase: "1695000" },
  price_decimals: 4,
};
if ((await view<any[]>("priced_rounds")).length === 0) {
  const p = await view("preview_priced_round", { terms });
  run.preview = p;
  save();
  console.log(`preview: price $${Number(p.price) / 1e6}, SAFEs ${p.safes.map((s: any) => s.shares).join(" / ")}, new ${p.investors.map((i: any) => i.shares).join(" / ")}, hash ${p.state_hash}`);
  if (!run.staleDone) {
    await propose("Grant 1 option from the pool (the cap table moves after the Series A preview)", [{ method: "grant_options", args: { count: "1" }, tgas: 20n }]);
    const stale = await propose(`Execute the Series A as previewed (stale hash ${p.state_hash.slice(0, 12)}…)`, [{ method: "execute_priced_round", args: { terms, expected_hash: p.state_hash }, tgas: 200n }], COMPANY, true);
    run.staleDone = { proposal: stale.id, status: stale.status, refusal: stale.reason };
    save();
  }
  const p2 = await view("preview_priced_round", { terms });
  run.preview = p2;
  save();
  await propose(`Execute the Series A: $5m at $15m pre-money, price $${Number(p2.price) / 1e6}, hash ${p2.state_hash}`, [{ method: "execute_priced_round", args: { terms, expected_hash: p2.state_hash }, tgas: 250n }]);
}

// 3. Secondary sales.
let offers = await view<any[]>("offers");
if (offers.length === 0) {
  const o = must("ada offers 100,000 common shares to dave for $50,000", await call(ada, COMPANY, "offer_shares", { class: 0, shares: "100000", price: usd(50_000).toString(), buyer: person("dave") }));
  must("dave pays $50,000 into escrow: the company's 2-minute right of first refusal starts", await pay(dave, usd(50_000), { buy: o.value }));
  const o2 = must("ben offers 50,000 common shares to carol for $30,000", await call(ben, COMPANY, "offer_shares", { class: 0, shares: "50000", price: usd(30_000).toString(), buyer: person("carol") }));
  must("carol pays $30,000 into escrow", await pay(carol, usd(30_000), { buy: o2.value }));
  await propose("Exercise the company's right of first refusal on ben's offer: the treasury buys the 50,000 shares at $30,000", [{ method: "ft_transfer_call", args: { receiver_id: COMPANY, amount: usd(30_000).toString(), msg: JSON.stringify({ rofr: o2.value }) }, deposit: 1n, tgas: 150n }], USDC);
  offers = await view<any[]>("offers");
}
if (offers[0].status === "Funded") {
  const early = await call(dave, COMPANY, "settle_offer", { offer: 0 }, 0n, 60n);
  step("dave tries to settle inside the company's window (expected: refused)", { ...early, ok: !early.ok, reason: early.reason }, { refusal: early.reason });
  const wait = Number(offers[0].window_ends) - Math.floor(Date.now() / 1000) + 8;
  if (wait > 0) {
    console.log(`waiting ${wait} s for the right-of-first-refusal window`);
    await sleep(wait * 1000);
  }
  must("after the window, dave settles: shares to dave, $50,000 to ada", await call(dave, COMPANY, "settle_offer", { offer: 0 }, 0n, 60n));
}

// 4. Bridge SAFEs, left outstanding: an MFN SAFE first, then a capped round whose terms the MFN holder adopts.
rs = await view<any[]>("rounds");
if (rs.length === 2) {
  await propose("Open an MFN SAFE round: no cap, no discount, most-favored-nation; $25k-$100k", [safeRound("MFN SAFE", null, usd(25_000), usd(100_000), { mfn: true })]);
  rs = await view<any[]>("rounds");
}
if (rs[2].raised === "0") must("bob pays $50,000 for an MFN SAFE", await pay(bob, usd(50_000), { invest: 2 }));
rs = await view<any[]>("rounds");
if (rs.length === 3) {
  await propose("Close the MFN round; open a bridge SAFE round: $30m post-money cap, 20% discount, $50k-$250k", [
    { method: "close_round", args: { round: 2 }, tgas: 100n },
    safeRound("Bridge SAFE ($30m cap, 20% discount)", usd(30_000_000), usd(50_000), usd(250_000), { discount_bps: 2000 }),
  ]);
  rs = await view<any[]>("rounds");
}
if (rs[3].raised === "0") must("alice pays $100,000 into the bridge round", await pay(alice, usd(100_000), { invest: 3 }));
rs = await view<any[]>("rounds");
if (rs[3].status === "Open") await propose("Close the bridge SAFE round", [{ method: "close_round", args: { round: 3 }, tgas: 100n }]);
const certs = await view<any[]>("nft_tokens_for_owner", { account_id: person("bob") });
const mfn = certs.find((t) => JSON.parse(t.metadata.extra).mfn);
if (mfn) must(`bob's MFN SAFE #${mfn.token_id} adopts the bridge round's terms ($30m cap, 20% discount)`, await call(bob, COMPANY, "adopt_mfn_terms", { token_id: mfn.token_id, round: 3 }));

// 5. A round that misses its minimum: one investor pays for another (as 1Click would from another chain), the
//    deadline passes, and anyone refunds each of them (decision 0007).
rs = await view<any[]>("rounds");
if (rs.length === 4) {
  if (BigInt(await view("storage_balance_of", { account_id: person("erin") })) === 0n) must("erin adds 0.01 NEAR storage balance on the cap table", await call(erin, COMPANY, "storage_deposit", {}, milli(10), 10n));
  const soon = String(Math.floor(Date.now() / 1000) + 150);
  await propose("Open a second bridge round: $40m post-money cap, $500k minimum, closing in 150 seconds", [{ method: "open_round", args: { terms: { name: "Bridge II ($40m cap)", safe: { cap: usd(40_000_000).toString(), discount_bps: 0, mfn: false, pro_rata: false }, min_raise: usd(500_000).toString(), max_raise: usd(1_000_000).toString(), deadline: soon } }, tgas: 30n }]);
  rs = await view<any[]>("rounds");
}
if (rs.length === 5 && rs[4].raised === "0" && rs[4].status === "Open") {
  must("dave pays $5,000 into Bridge II", await pay(dave, usd(5_000), { invest: 4 }));
  must("carol pays $3,000 into Bridge II for erin (the investment is erin's)", await call(carol, USDC, "ft_transfer_call", { receiver_id: COMPANY, amount: usd(3_000).toString(), msg: JSON.stringify({ invest: 4, for: person("erin") }) }, 1n, 100n));
}
rs = await view<any[]>("rounds");
if (rs.length === 5 && rs[4].investments.some((i: any) => !i.refunded)) {
  const wait = Number(rs[4].terms.deadline) - Math.floor(Date.now() / 1000) + 5;
  if (wait > 0) {
    console.log(`waiting ${wait} s for Bridge II's deadline`);
    await sleep(wait * 1000);
  }
  for (const inv of rs[4].investments.filter((i: any) => !i.refunded)) {
    const who = inv.investor.split(".")[0];
    must(`the round missed its minimum: bob (anyone) refunds ${who}'s $${Number(inv.amount) / 1e6}, which goes to ${who}`, await call(bob, COMPANY, "refund", { round: 4, investor: inv.investor }, 0n, 60n));
  }
}

const t = await view("cap_table");
run.final = { company_capitalization: t.company_capitalization, positions: t.positions.length, certificates: t.certificates.map((c: any) => c.token_id) };
save();
for (const who of [ada, ben, erin, alice, bob, carol, dave]) {
  const extra = (await chain.balance(who.accountId)) - milli(20);
  if (extra > milli(5)) await who.signAndSendTransaction({ receiverId: FUNDER, actions: [actions.transfer(extra)], waitUntil: "FINAL" } as any);
}
console.log(`funder: ${Number(await chain.balance(FUNDER)) / 1e24} NEAR`);
console.log(`\ndone: ${t.positions.length} positions, ${t.certificates.length} SAFE certificates outstanding; deploy/testnet-run.json written`);
