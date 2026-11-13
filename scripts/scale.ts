// How big a cap table the conversion handles inside NEAR's gas limit: a priced round with k outstanding SAFEs (all
// with different caps and discounts, the worst case for the exact arithmetic), as a real transaction on a sandbox
// (the gas a board's execution pays), for k up to the contract's cap of 60.   npm run scale
import { actions } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { convert } from "../ref/reference.ts";
import { capJson, rng, safeJson } from "./lib/cases.ts";
import { call, Chain, TGAS } from "./lib/near.ts";
import { postmoneyWasm, stopSandbox, wasm } from "./lib/world.ts";

const sandbox = await Sandbox.start({});
const chain = new Chain(sandbox.rpcUrl);
chain.remember(DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY);
const root = chain.account(DEFAULT_ACCOUNT_ID);
const calc = await chain.subAccount(root, "calc", "20");
await calc.signAndSendTransaction({
  receiverId: calc.accountId,
  actions: [actions.deployContract(postmoneyWasm()), actions.functionCall("new", { owner_id: root.accountId, company: "Scale", usdc: root.accountId, treasury: root.accountId, founders: [{ account: root.accountId, shares: "1" }], options: "0", pool: "0", rofr_secs: null }, 100n * TGAS, 0n)],
  waitUntil: "FINAL",
});
const r = rng(60);
let fails = 0;
// Caps are odd, distinct numbers of dollars ($20m to $60m), so no two denominators share a factor: the worst case
// for the exact arithmetic. The contract allows at most 60 outstanding SAFEs over at most 8 different (cap, discount)
// pairs; the first two rows show why the second limit exists.
const termsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ cap: (20_000_000n + r.int(0n, 40_000_000n)) * 1_000_000n + 2n * BigInt(i) + 1n, discount_bps: Number(r.pick([0n, 1000n, 1500n, 2000n])) }));
for (const [k, distinct] of [[2, 2], [10, 10], [20, 20], [60, 4], [60, 8]]) {
  const cap = { outstanding: 9_000_000n, options: 500_000n, pool: 500_000n };
  const terms_ = termsOf(distinct);
  const safes = Array.from({ length: k }, (_, i) => ({ purchase: (5_000n + r.int(0n, 20_000n)) * 1_000_000n + BigInt(i), ...terms_[i % distinct] }));
  const terms = { pre_money: 40_000_000n * 1_000_000n, new_money: [10_000_000n * 1_000_000n], pool: { target_bps: 1000 }, price_decimals: 4 };
  // The reference brute-forces every assignment (2^k): compare with it up to 10 SAFEs; above, check each SAFE took the greater basis.
  const want = k <= 10 ? convert(cap, safes, terms) : null;
  // simulate_conversion as a transaction (not a view) so the gas burnt is measured.
  const res = await call(root, calc.accountId, "simulate_conversion", { cap: capJson(cap), safes: safes.map(safeJson), terms: { pre_money: terms.pre_money.toString(), new_money: terms.new_money.map(String), pool: terms.pool, price_decimals: 4 } }, 0n, 300n);
  const same = res.ok && (want
    ? res.value.price === `${want.price}` && JSON.stringify(res.value.safes.map((s: any) => s.shares)) === JSON.stringify(want.safes.map((s) => `${s.shares}`))
    : res.value.safes.every((s: any) => BigInt(s.shares) >= BigInt(s.other_basis_shares)));
  const allowed = k <= 60 && distinct <= 8;
  if (allowed && !same) fails++;
  console.log(`${same ? "✓" : allowed ? "✗" : "–"} conversion, ${k} SAFEs over ${distinct} different caps${allowed ? "" : " (more than the contract allows)"}: ${res.ok ? `${res.gas?.toFixed(1)} TGas burnt, ${want ? "equal to the reference" : "each SAFE took the greater basis"}` : res.reason}`);
}
// The waterfall view: 60 SAFEs over 8 caps and 20 preferred holders, at a sale where most convert.
for (const [k, distinct, prefs] of [[20, 8, 10], [60, 8, 20]]) {
  const terms_ = termsOf(distinct);
  const claims: any[] = Array.from({ length: k }, (_, i) => ({ safe: { purchase: ((5_000n + r.int(0n, 20_000n)) * 1_000_000n + BigInt(i)).toString(), cap: terms_[i % distinct].cap.toString() } }));
  for (let i = 0; i < prefs; i++) claims.push({ preferred: { shares: String(200_000 + i * 1000), preference: String((200_000 + i * 1000) * 1_100_000) } });
  const res = await call(root, calc.accountId, "simulate_waterfall", { exit: (80_000_000n * 1_000_000n).toString(), common: "9500000", claims }, 0n, 300n);
  const conv = res.ok ? res.value.claims.filter((c: any) => c.converts).length : 0;
  if (!res.ok) fails++;
  console.log(`${res.ok ? "✓" : "✗"} waterfall, ${k} SAFEs over ${distinct} caps and ${prefs} preferred holders: ${res.ok ? `${res.gas?.toFixed(1)} TGas burnt, ${conv} convert` : res.reason}`);
}
// End to end at the contract's caps: 60 investors in 8 rounds with 8 different caps and discounts, closed, then the
// board previews and executes a priced round that converts all 60 SAFEs, and the waterfall view on the result.
{
  const usdc = await chain.subAccount(root, "usdc", "10");
  await usdc.signAndSendTransaction({ receiverId: usdc.accountId, actions: [actions.deployContract(wasm("test_usdc.wasm")), actions.functionCall("new", {}, 30n * TGAS, 0n)], waitUntil: "FINAL" });
  const board = await chain.subAccount(root, "board", "20");
  const big = await chain.subAccount(root, "bigco", "30");
  await big.signAndSendTransaction({ receiverId: big.accountId, actions: [actions.deployContract(postmoneyWasm()), actions.functionCall("new", { owner_id: board.accountId, company: "Bigco", usdc: usdc.accountId, treasury: board.accountId, founders: [{ account: root.accountId, shares: "9000000" }], options: "500000", pool: "500000", rofr_secs: null }, 100n * TGAS, 0n)], waitUntil: "FINAL" });
  const B = big.accountId;
  await call(root, usdc.accountId, "storage_deposit", { account_id: B }, 10n ** 22n);
  await call(root, usdc.accountId, "storage_deposit", { account_id: board.accountId }, 10n ** 22n);
  await call(root, B, "storage_deposit", { account_id: board.accountId }, 5n * 10n ** 24n);
  const deadline = String((await chain.secs()) + 3600);
  const t8 = termsOf(8);
  for (let g = 0; g < 8; g++) {
    const r0 = await call(board, B, "open_round", { terms: { name: `Round ${g}`, safe: { cap: t8[g].cap.toString(), discount_bps: t8[g].discount_bps, mfn: false, pro_rata: false }, min_raise: "1000000", max_raise: (1_000_000n * 1_000_000n).toString(), deadline } });
    if (!r0.ok) throw new Error(`open: ${r0.reason}`);
  }
  const nine = await call(board, B, "open_round", { terms: { name: "Ninth terms", safe: { cap: (99_000_000_000_001n).toString(), discount_bps: 0, mfn: false, pro_rata: false }, min_raise: "1", max_raise: "2", deadline } });
  console.log(`${!nine.ok && (nine.reason ?? "").includes("different SAFE terms") ? "✓" : "✗"} a ninth different (cap, discount) is refused: ${nine.reason}`);
  if (nine.ok) fails++;
  const investors = await Promise.all(Array.from({ length: 60 }, (_, i) => chain.subAccount(root, `inv${i}`, "2")));
  await Promise.all(investors.map(async (a, i) => {
    await call(a, usdc.accountId, "mint", { amount: (100_000n * 1_000_000n).toString() }, 10n ** 22n, 10n);
    await call(a, B, "storage_deposit", {}, 5n * 10n ** 22n, 10n);
    const r1 = await call(a, usdc.accountId, "ft_transfer_call", { receiver_id: B, amount: ((5_000n + BigInt(i) * 137n) * 1_000_000n).toString(), msg: JSON.stringify({ invest: i % 8 }) }, 1n, 100n);
    if (!r1.ok) throw new Error(`invest ${i}: ${r1.reason}`);
  }));
  let closeGas = 0;
  for (let g = 0; g < 8; g++) {
    const c = await call(board, B, "close_round", { round: g }, 0n, 300n);
    if (!c.ok) throw new Error(`close: ${c.reason}`);
    closeGas = Math.max(closeGas, c.gas ?? 0);
  }
  const supply = await chain.view(B, "nft_total_supply");
  console.log(`${supply === "60" ? "✓" : "✗"} 60 SAFE certificates minted across 8 rounds (the heaviest close, 8 investors: ${closeGas.toFixed(1)} TGas)`);
  if (supply !== "60") fails++;
  const terms = { name: "Series A", pre_money: (40_000_000n * 1_000_000n).toString(), investors: [{ account: root.accountId, cash: (10_000_000n * 1_000_000n).toString() }], pool: { target_bps: 1000 }, price_decimals: 4 };
  const p = await chain.view<any>(B, "preview_priced_round", { terms });
  const ex = await call(board, B, "execute_priced_round", { terms, expected_hash: p.state_hash }, 0n, 300n);
  const after = await chain.view(B, "nft_total_supply");
  console.log(`${ex.ok && after === "0" ? "✓" : "✗"} the board executes a priced round converting all 60 SAFEs: ${ex.ok ? `${ex.gas?.toFixed(1)} TGas burnt (limit 300)` : ex.reason}`);
  if (!ex.ok) fails++;
  const wf = await call(root, B, "waterfall", { exit: (90_000_000n * 1_000_000n).toString() }, 0n, 300n);
  console.log(`${wf.ok ? "✓" : "✗"} the waterfall view on the result (60 Safe Preferred holders, the Series A, common): ${wf.ok ? `${wf.gas?.toFixed(1)} TGas` : wf.reason}`);
  if (!wf.ok) fails++;
}
await stopSandbox(sandbox);
process.exit(fails ? 1 : 0);
