// The whole life of a company's cap table on a local sandbox, with the board as a real Sputnik DAO (the bytecode
// sputnik-v2.testnet deploys): YC's Example 1, on chain. Every board step is a proposal two of three council members
// approve. Free, no keys, no Rust.   npm run sandbox
//
//  1. Acme Robotics: founders 9,250,000 common, options 650,000, pool 100,000.
//  2. Two SAFE rounds: $200k at a $4m post-money cap (alice), $800k at $8m with pro rata (bob). alice sends $250k:
//     $200k is kept and $50k comes back in the same transaction. The board closes both: the money goes to the DAO's
//     treasury, each investor gets a SAFE certificate (NEP-171).
//  3. A Series A, YC's terms: the preview gives YC's numbers to the share and a hash; a change to the cap table makes
//     that hash stale and the DAO's execution of it fails; the DAO executes the fresh one; the cap table is YC's.
//  4. The waterfall; a secondary sale the company lets through; one it buys itself (its right of first refusal).
//  5. A round that misses its minimum: anyone refunds anyone, and the money only goes back to who paid.
import { call, Checks, events, usd, type Result } from "./lib/near.ts";
import { finish, startWorld } from "./lib/world.ts";

const c = new Checks();
const t0 = Date.now();
const w = await startWorld({ board: "dao", rofrSecs: 25 });
const { chain, A, B, U, alice, bob, carol, dave, ada, ben, mallory } = w;
console.log(`sandbox world up in ${Math.round((Date.now() - t0) / 1000)} s: test USDC ${U}, cap table ${A}, board ${B} (Sputnik DAO)`);
const must = (r: Result, what: string) => {
  c.check(r.ok, what, r.ok ? (r.gas ? `${r.gas.toFixed(1)} TGas` : "") : r.reason);
  return r;
};
const n = (x: any) => BigInt(x);

c.section("1. The company");
const t = await w.view("cap_table");
c.check(t.board === B && t.positions.length === 2 && t.options === "650000" && t.pool === "100000", "Acme Robotics: board = the DAO, founders 6,000,000 + 3,250,000 common, options 650,000, pool 100,000");
c.check(t.company_capitalization === "10000000", "fully diluted: 10,000,000 shares", t.company_capitalization);

c.section("2. SAFE rounds, escrow, certificates");
const deadline = String((await w.secs()) + 24 * 3600);
const r0 = must(await w.boardCall("open_round", { terms: { name: "Pre-seed SAFE ($4m cap)", safe: { cap: usd(4_000_000).toString(), discount_bps: 0, mfn: false, pro_rata: false }, min_raise: usd(100_000).toString(), max_raise: usd(200_000).toString(), deadline } }), "DAO proposal: open a SAFE round, $4m post-money cap, $100k to $200k");
const r1 = must(await w.boardCall("open_round", { terms: { name: "Seed SAFE ($8m cap, pro rata)", safe: { cap: usd(8_000_000).toString(), discount_bps: 0, mfn: false, pro_rata: true }, min_raise: usd(400_000).toString(), max_raise: usd(800_000).toString(), deadline } }), "DAO proposal: open a second round, $8m cap with a pro rata side letter");
c.check(r0.proposal !== undefined && r1.proposal !== undefined, "both were Sputnik proposals approved by 2 of 3 council members", `proposals ${r0.proposal}, ${r1.proposal}`);
const before = await w.usdcOf(alice.accountId);
const inv = must(await w.pay(alice, usd(250_000), { invest: 0 }), "alice pays $250,000 into the $200k round");
c.check(before - (await w.usdcOf(alice.accountId)) === usd(200_000), "the round kept $200,000 and handed back $50,000 in the same transaction", events(inv, "postmoney").map((e) => e.event).join(","));
must(await w.pay(bob, usd(800_000), { invest: 1 }), "bob pays $800,000 into the $8m round");
c.check((await w.usdcOf(A)) === usd(1_000_000), "$1,000,000 sits in the cap table's escrow");
const closeA = must(await w.boardCall("close_round", { round: 0 }), "DAO proposal: close round 0");
must(await w.boardCall("close_round", { round: 1 }), "DAO proposal: close round 1");
c.check((await w.usdcOf(B)) === usd(1_000_000) && (await w.usdcOf(A)) === 0n, "the DAO's treasury holds the $1,000,000; the escrow is empty", closeA.proposal);
const aliceSafes = await w.view("nft_tokens_for_owner", { account_id: alice.accountId });
const bobSafe = await w.view("nft_token", { token_id: "2" });
c.check(aliceSafes.length === 1 && aliceSafes[0].metadata.title.includes("$200,000") && aliceSafes[0].metadata.media.startsWith("data:image/svg+xml"), "alice holds SAFE certificate #1 (NEP-171), its terms and an SVG certificate in its metadata", aliceSafes[0]?.metadata.title);
c.check(bobSafe.owner_id === bob.accountId && JSON.parse(bobSafe.metadata.extra).pro_rata === true, "bob holds #2 with its pro rata right", bobSafe.metadata.title);
const t2 = await w.view("cap_table");
const lines = Object.fromEntries(t2.as_converted.map((l: any) => [l.label, l.shares]));
c.check(t2.company_capitalization === "11764705" && lines["SAFE #1 (at its cap)"] === "588235" && lines["SAFE #2 (at its cap)"] === "1176470", "post-SAFE, at their caps: Company Capitalization 11,764,705, alice 588,235 (5%), bob 1,176,470 (10%): YC's table", JSON.stringify(lines));

c.section("3. The Series A: preview, a stale hash, execution");
const terms = {
  name: "Series A",
  pre_money: usd(15_000_000).toString(),
  investors: [
    { account: carol.accountId, cash: usd(4_000_000).toString() }, // the lead, YC's Investor C
    { account: bob.accountId, cash: "499998970000" }, // bob's pro rata, $499,998.97 as YC states it
    { account: dave.accountId, cash: "500001030000" }, // other new investors
  ],
  pool: { increase: "1695000" },
  price_decimals: 4,
};
const p = await w.view("preview_priced_round", { terms });
c.check(p.price === "1114400" && p.conversion.company_capitalization === "11764705", "preview: price $1.1144, Company Capitalization 11,764,705", p.state_hash.slice(0, 16));
c.check(p.safes.map((s: any) => s.shares).join() === "588235,1176470" && p.investors.map((i: any) => i.shares).join() === "3589375,448671,448673", "preview: SAFEs 588,235 and 1,176,470 at their caps; new money 3,589,375 / 448,671 / 448,673: YC's numbers");
c.check(p.safes[1].pro_rata_shares === "448671", "bob's pro rata right: 448,671 shares, what YC's guide gives him", p.safes[1].pro_rata_shares);
must(await w.boardCall("grant_options", { count: "1" }), "meanwhile the board grants one option (the cap table moved)");
const stale = await w.boardCall("execute_priced_round", { terms, expected_hash: p.state_hash }, { tgas: 280n });
c.check(!stale.ok, "the DAO executes the old preview's hash: Sputnik's call fails, nothing converts", stale.reason);
c.check((await w.view("nft_total_supply")) === "2", "both SAFE certificates are still outstanding");
const p2 = await w.view("preview_priced_round", { terms });
c.check(p2.state_hash !== p.state_hash && p2.price === p.price, "a fresh preview: same numbers (an option moved inside the pool), a new hash", p2.state_hash.slice(0, 16));
const ex = must(await w.boardCall("execute_priced_round", { terms, expected_hash: p2.state_hash }, { tgas: 280n }), "DAO proposal with the fresh hash: the Series A executes");
const burns = events(ex, "nep171").filter((e) => e.event === "nft_burn").length;
c.check(burns === 2 && (await w.view("nft_total_supply")) === "0", "both SAFE certificates burned (NEP-171 nft_burn)", `${burns} burns`);
const t3 = await w.view("cap_table");
const by = (holder: string) => t3.positions.filter((x: any) => x.holder === holder).reduce((a: bigint, x: any) => a + n(x.shares), 0n);
const fd = t3.positions.reduce((a: bigint, x: any) => a + n(x.shares), 0n) + n(t3.options) + n(t3.pool);
c.check(by(alice.accountId) === 588_235n && by(bob.accountId) === 1_625_141n && by(carol.accountId) === 3_589_375n && by(dave.accountId) === 448_673n, "after the Series A: alice 588,235; bob 1,625,141; carol 3,589,375; dave 448,673: YC's table");
c.check(t3.pool === "1794999" && fd === 17_946_424n, "options available 1,795,000 (less the one granted) and 17,946,424 fully diluted: YC's totals", `${t3.pool}, ${fd}`);
const cls = t3.classes.map((x: any) => `${x.name} @ ${x.price}`);
c.check(cls.includes("Series A @ 1114400") && cls.some((x: string) => x.startsWith("Series A-1 (Safe Preferred) @ 340000")) && cls.some((x: string) => x.startsWith("Series A-2 (Safe Preferred) @ 680000")), "classes: Series A at $1.1144, Safe Preferred A-1 at $0.34 and A-2 at $0.68 (YC's per-share liquidation amounts)", cls.join("; "));

c.section("4. Exits and secondaries");
const wf = await w.view("waterfall", { exit: usd(10_000_000).toString() });
const conv = (label: string) => wf.lines.filter((l: any) => l.label.startsWith(label)).map((l: any) => l.converts);
c.check(conv("Series A-1").join() === "true" && conv("Series A-2").join() === "false" && wf.lines.filter((l: any) => l.label === "Series A").every((l: any) => !l.converts) && n(wf.detail.dust) < 20n,
  "a $10m sale: A-1 ($0.34 a share) converts; A-2 ($0.68) and the Series A ($1.1144) take their 1x preference; common shares the rest",
  wf.lines.map((l: any) => `${l.holder.split(".")[0]} ${l.label} ${l.converts ? "converts" : "pref"} $${(Number(l.payout) / 1e6).toFixed(0)}`).join(", "));
const wf2 = await w.view("waterfall", { exit: usd(100_000_000).toString() });
c.check(wf2.lines.filter((l: any) => l.label.startsWith("Series A")).every((l: any) => l.converts), "a $100m sale: every preferred holder converts to common");
const offer = await call(ada, A, "offer_shares", { class: 0, shares: "100000", price: usd(50_000).toString(), buyer: dave.accountId });
must(offer, "ada offers 100,000 common shares to dave for $50,000");
must(await w.pay(dave, usd(50_000), { buy: offer.value }), "dave pays $50,000 into escrow: the company's 25-second right of first refusal starts");
const early = await call(mallory, A, "settle_offer", { offer: offer.value });
c.refused(early, "right of first refusal is still open", "settling before the window ends is refused");
await w.sleep(26_000);
const adaBefore = await w.usdcOf(ada.accountId);
must(await call(mallory, A, "settle_offer", { offer: offer.value }), "the window passes; anyone settles");
const daveCommon = (await w.view("cap_table")).positions.find((x: any) => x.holder === dave.accountId && x.class === 0);
c.check((await w.usdcOf(ada.accountId)) - adaBefore === usd(50_000) && daveCommon?.shares === "100000", "ada got $50,000; dave holds the 100,000 common shares", daveCommon?.shares);
const offer2 = await call(ben, A, "offer_shares", { class: 0, shares: "50000", price: usd(30_000).toString(), buyer: mallory.accountId });
must(offer2, "ben offers 50,000 common to mallory for $30,000");
must(await w.pay(mallory, usd(30_000), { buy: offer2.value }), "mallory pays into escrow");
const benBefore = await w.usdcOf(ben.accountId);
const malBefore = await w.usdcOf(mallory.accountId);
const match = must(await w.boardCall("ft_transfer_call", { receiver_id: A, amount: usd(30_000).toString(), msg: JSON.stringify({ rofr: offer2.value }) }, { receiver: U, deposit: 1n, tgas: 200n, why: "Exercise the right of first refusal on ben's offer" }), "DAO proposal: the treasury matches the price (right of first refusal)");
void match;
const t4 = await w.view("cap_table");
c.check((await w.usdcOf(ben.accountId)) - benBefore === usd(30_000) && (await w.usdcOf(mallory.accountId)) - malBefore === usd(30_000), "ben got $30,000 from the company; mallory's escrow came back");
c.check(t4.positions.some((x: any) => x.holder === B && x.shares === "50000"), "the company holds the 50,000 shares it bought back");

c.section("5. A round that misses its minimum");
const soon = String((await w.secs()) + 6);
must(await w.boardCall("open_round", { terms: { name: "Bridge SAFE", safe: { cap: usd(30_000_000).toString(), discount_bps: 2000, mfn: false, pro_rata: false }, min_raise: usd(2_000_000).toString(), max_raise: usd(3_000_000).toString(), deadline: soon } }), "DAO proposal: a bridge round, $2m minimum, a few seconds to fill");
must(await w.pay(mallory, usd(10_000), { invest: 2 }), "mallory puts in $10,000");
await w.sleep(8_000);
const malB = await w.usdcOf(mallory.accountId);
const aliceB = await w.usdcOf(alice.accountId);
must(await call(alice, A, "refund", { round: 2, investor: mallory.accountId }), "after the deadline, alice (anyone) triggers mallory's refund");
c.check((await w.usdcOf(mallory.accountId)) - malB === usd(10_000) && (await w.usdcOf(alice.accountId)) === aliceB, "the $10,000 went back to mallory, not to the caller");
const rr = (await w.view("rounds"))[2];
c.check(rr.status === "Refunding" && rr.raised === "0", "the round is refunding with nothing left in escrow", rr.status);

await finish(c, `sandbox checks passed (${Math.round((Date.now() - t0) / 1000)} s)`, w.stop);
