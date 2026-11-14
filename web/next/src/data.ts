// What the page reads, and the two models it runs. Live: everything is the contract's own views on NEAR testnet. If no RPC
// answers: the recorded snapshot (web/public/snapshot.json), and the models run the independent reference
// (ref/reference.ts) in the browser instead, which the page says.
import { useEffect, useState } from "react";
import { convert as refConvert, waterfall as refWaterfall, Refused, type Claim } from "../../../ref/reference.ts";
import { BOARD, COMPANY, finalBlock, USDC, view, ViewError } from "../../src/chain.ts";
import { short } from "../../src/format.ts";

export type Line = { holder: string; label: string; shares: string };
export type State = {
  cap_table: any; rounds: any[]; offers: any[]; priced_rounds: any[]; certificates: any[]; proposals: any[];
  treasury_usdc: string; recorded_at?: string; block?: number;
};
export type Run = { steps?: { what: string; tx?: string; proposal?: number }[]; staleDone?: { proposal: number; refusal: string; tx: string } } | null;
export type Data = { S: State; live: boolean; run: Run };

async function loadLive(): Promise<State> {
  const [cap_table, rounds, offers, priced_rounds, proposals, treasury_usdc, block] = await Promise.all([
    view(COMPANY, "cap_table"), view(COMPANY, "rounds"), view(COMPANY, "offers"), view(COMPANY, "priced_rounds"),
    view(BOARD, "get_proposals", { from_index: 0, limit: 100 }), view<string>(USDC, "ft_balance_of", { account_id: BOARD }), finalBlock(),
  ]);
  const certificates = await Promise.all(cap_table.certificates.map((c: any) => view(COMPANY, "nft_token", { token_id: c.token_id })));
  return { cap_table, rounds, offers, priced_rounds, proposals, treasury_usdc, certificates, block };
}

let loading: Promise<Data> | null = null;
function load(): Promise<Data> {
  return (loading ??= (async () => {
    const run = await fetch("./run.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    try {
      return { S: await loadLive(), live: true, run };
    } catch {
      return { S: await fetch("./snapshot.json").then((r) => r.json()), live: false, run };
    }
  })());
}

export function useData(): Data | null {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => { let on = true; load().then((x) => { if (on) setD(x); }); return () => { on = false; }; }, []);
  return d;
}

// ---- holders, grouped into kinds that get a colour ----
const FOUNDERS = ["ada", "ben"];
export const LEAD = "series-b-lead.testnet";
export function kindOf(l: { holder: string; label: string }): string {
  if (l.label.startsWith("SAFE #")) return "safe";
  if (l.label.includes("Safe Preferred")) return "safepref";
  if (l.label.startsWith("Options")) return "options";
  if (l.label.startsWith("Unissued")) return "pool";
  if (l.label === "Pool increase") return "poolnew";
  if (l.label === "Series B") return "seriesb";
  if (l.label === "Common") return l.holder === BOARD ? "treasury" : FOUNDERS.includes(short(l.holder)) ? "common" : "common2";
  return "seriesa";
}
const ORDER = ["common", "common2", "treasury", "seriesa", "safepref", "seriesb", "safe", "options", "pool", "poolnew"];
export const who = (holder: string) =>
  holder === BOARD ? "Acme (bought back)" : holder === LEAD ? "New lead" : holder === "options" ? "Option holders" : holder === "pool" ? "Option pool" : short(holder);
export const describe = (l: { holder: string; label: string }) => (l.label === "Common" && l.holder === BOARD ? "Common, held by the company" : l.label);
export const sortLines = (lines: Line[]) => [...lines].sort((a, b) => ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b)) || Number(BigInt(b.shares) - BigInt(a.shares)));
export const sum = (lines: { shares: string }[]) => lines.reduce((a, l) => a + BigInt(l.shares), 0n);

// ---- the next priced round ----
/** The contract's preview_priced_round, or offline the reference's result in the same shape. */
export async function preview(d: Data, pre: bigint, nw: bigint, pool: number): Promise<any> {
  const terms = { name: "Series B", pre_money: pre.toString(), investors: [{ account: LEAD, cash: nw.toString() }], pool: pool > 0 ? { target_bps: pool * 100 } : { increase: "0" }, price_decimals: 4 };
  if (d.live) return view(COMPANY, "preview_priced_round", { terms });
  const ct = d.S.cap_table;
  const cap = { outstanding: ct.positions.reduce((a: bigint, p: any) => a + BigInt(p.shares), 0n), options: BigInt(ct.options), pool: BigInt(ct.pool) };
  const safes = ct.certificates.map((c: any) => ({ purchase: BigInt(c.purchase), cap: c.terms.cap ? BigInt(c.terms.cap) : null, discount_bps: c.terms.discount_bps }));
  try {
    const r = refConvert(cap, safes, { pre_money: pre, new_money: [nw], pool: pool > 0 ? { target_bps: pool * 100 } : { increase: 0n }, price_decimals: 4 });
    return {
      price: `${r.price}`, state_hash: "",
      conversion: { company_capitalization: `${r.company_capitalization}`, pool_increase: `${r.pool_increase}`, pool_after: `${r.pool_after}`, new_shares_total: `${r.new_shares_total}`, post_money_shares: `${r.post_money_shares}` },
      safes: ct.certificates.map((c: any, i: number) => ({ token_id: c.token_id, owner: c.owner, purchase: c.purchase, discount_bps: c.terms.discount_bps, shares: `${r.safes[i].shares}`, basis: r.safes[i].basis, other_basis_shares: `${r.safes[i].other_basis_shares}` })),
      investors: [{ account: LEAD, cash: nw.toString(), shares: `${r.new_shares[0]}` }],
    };
  } catch (e) {
    if (e instanceof Refused) throw new ViewError(e.message);
    throw e;
  }
}

/** The cap table after a previewed round: every position as it is, the pool and its increase, the SAFEs' and the new money's shares. */
export function afterRound(ct: any, p: any): Line[] {
  const after: Line[] = ct.as_converted.filter((l: Line) => !l.label.startsWith("SAFE #") && !l.label.startsWith("Unissued"));
  after.push({ holder: "pool", label: "Unissued option pool", shares: ct.pool });
  if (BigInt(p.conversion.pool_increase) > 0n) after.push({ holder: "pool", label: "Pool increase", shares: p.conversion.pool_increase });
  for (const s of p.safes) after.push({ holder: s.owner, label: s.basis === "cap" || s.discount_bps > 0 ? `Series B-${s.token_id} (Safe Preferred)` : "Series B", shares: s.shares });
  for (const i of p.investors) after.push({ holder: i.account, label: "Series B", shares: i.shares });
  return after;
}

// ---- a sale of the company ----
export async function waterfallAt(d: Data, exit: bigint): Promise<{ lines: { holder: string; label: string; converts: boolean; shares: string; payout: string }[] }> {
  if (d.live) return view(COMPANY, "waterfall", { exit: exit.toString() });
  const ct = d.S.cap_table;
  const claims: Claim[] = [];
  const labels: [string, string][] = [];
  for (const c of ct.certificates) { claims.push({ safe: { purchase: BigInt(c.purchase), cap: c.terms.cap ? BigInt(c.terms.cap) : null } }); labels.push([c.owner, `SAFE #${c.token_id}`]); }
  const common: any[] = [];
  for (const p of ct.positions) {
    if (ct.classes[p.class].preferred) { claims.push({ preferred: { shares: BigInt(p.shares), preference: BigInt(p.preference) } }); labels.push([p.holder, ct.classes[p.class].name]); }
    else common.push(p);
  }
  const commonTotal = common.reduce((a, p) => a + BigInt(p.shares), 0n) + BigInt(ct.options);
  const w = refWaterfall(exit, commonTotal, claims);
  const lines = labels.map(([holder, label], i) => ({ holder, label, converts: w.claims[i].converts, shares: `${w.claims[i].shares}`, payout: `${w.claims[i].payout}` }));
  for (const p of common) lines.push({ holder: p.holder, label: "Common", converts: true, shares: p.shares, payout: `${(w.common_payout * BigInt(p.shares)) / commonTotal}` });
  if (BigInt(ct.options) > 0n) lines.push({ holder: "options", label: "Options (as exercised)", converts: true, shares: ct.options, payout: `${(w.common_payout * BigInt(ct.options)) / commonTotal}` });
  return { lines };
}

// ---- sliders on a log scale, rounded to two significant figures ----
export const logScale = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, t / 1000);
export function nice(x: number): number { const p = Math.pow(10, Math.floor(Math.log10(x)) - 1); return Math.round(x / p) * p; }
export const dollars = (x: number) => BigInt(Math.round(x)) * 1_000_000n;
