// Random cap tables and priced rounds for the property tests, from a seeded generator so every run and every
// machine sees the same cases. Money in micro-dollars, as strings in JSON (the contract's format).
import type { Cap, Claim, Pool, Safe, Terms } from "../../ref/reference.ts";

/** xorshift128+ on BigInt: small, seeded, the same everywhere. */
export function rng(seed: number) {
  let s0 = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
  let s1 = (BigInt(seed) ^ 0xdeadbeefn) * 0xbf58476d1ce4e5b9n + 7n;
  const M = (1n << 64n) - 1n;
  const next = () => {
    let x = s0 & M;
    const y = s1 & M;
    s0 = y;
    x ^= (x << 23n) & M;
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (s1 + y) & M;
  };
  for (let i = 0; i < 8; i++) next();
  /** uniform in [lo, hi] */
  const int = (lo: bigint, hi: bigint) => lo + (next() % (hi - lo + 1n));
  const pick = <T>(xs: T[]) => xs[Number(int(0n, BigInt(xs.length - 1)))];
  const chance = (pct: number) => int(1n, 100n) <= BigInt(pct);
  return { int, pick, chance };
}

const USD = 1_000_000n;
export type Case = { id: number; cap: Cap; safes: Safe[]; terms: Terms };

export function generate(n: number, seed = 20261113, opts: { maxSafes?: number } = {}): Case[] {
  const r = rng(seed);
  const out: Case[] = [];
  for (let id = 0; id < n; id++) {
    const cap: Cap = {
      outstanding: r.int(1_000_000n, 20_000_000n),
      options: r.chance(70) ? r.int(0n, 2_000_000n) : 0n,
      pool: r.chance(80) ? r.int(0n, 3_000_000n) : 0n,
    };
    const safes: Safe[] = [];
    const k = Number(r.int(0n, BigInt(opts.maxSafes ?? 6)));
    let owned = 0; // keep the SAFEs at their caps under ~85% of the company
    for (let i = 0; i < k; i++) {
      const purchase = r.int(10_000n, 2_000_000n) * USD + (r.chance(30) ? r.int(0n, 99n) * 10_000n : 0n);
      const capped = r.chance(88);
      let cap_: bigint | null = capped ? r.pick([2n, 4n, 5n, 6n, 8n, 10n, 12n, 15n, 20n, 25n, 30n, 40n]) * 1_000_000n * USD + (r.chance(20) ? r.int(1n, 999_999n) * USD : 0n) : null;
      if (cap_ !== null) {
        const share = Number(purchase) / Number(cap_);
        if (owned + share > 0.85) cap_ = null;
        else owned += share;
      }
      const discount_bps = cap_ === null || r.chance(25) ? Number(r.pick([0n, 1000n, 1500n, 2000n, 2500n])) : 0;
      safes.push({ purchase, cap: cap_, discount_bps: cap_ === null && discount_bps === 0 && r.chance(50) ? 2000 : discount_bps });
    }
    const investors = Number(r.int(1n, 4n));
    const new_money = Array.from({ length: investors }, () => r.int(50_000n, 8_000_000n) * USD + (r.chance(40) ? r.int(0n, 99n) * 10_000n : 0n));
    const pool: Pool = r.chance(50) ? { increase: r.chance(20) ? 0n : r.int(0n, 3_000_000n) } : { target_bps: Number(r.pick([500n, 800n, 1000n, 1200n, 1500n, 2000n])) };
    const terms: Terms = {
      pre_money: r.int(2n, 80n) * 1_000_000n * USD + (r.chance(30) ? r.int(1n, 999n) * 1000n * USD : 0n),
      new_money,
      pool,
      price_decimals: Number(r.pick([4n, 4n, 4n, 4n, 2n, 6n, 0n])),
    };
    out.push({ id, cap, safes, terms });
  }
  return out;
}

export type WCase = { id: number; exit: bigint; common: bigint; claims: Claim[] };
export function generateWaterfalls(n: number, seed = 20261114): WCase[] {
  const r = rng(seed);
  const out: WCase[] = [];
  for (let id = 0; id < n; id++) {
    const common = r.int(1_000_000n, 15_000_000n);
    const claims: Claim[] = [];
    const k = Number(r.int(0n, 5n));
    let owned = 0;
    for (let i = 0; i < k; i++) {
      if (r.chance(50)) {
        const purchase = r.int(25_000n, 3_000_000n) * USD;
        let cap: bigint | null = r.chance(85) ? r.pick([3n, 5n, 8n, 10n, 15n, 25n]) * 1_000_000n * USD : null;
        if (cap !== null) {
          const s = Number(purchase) / Number(cap);
          if (owned + s > 0.8) cap = null;
          else owned += s;
        }
        claims.push({ safe: { purchase, cap } });
      } else {
        const shares = r.int(100_000n, 6_000_000n);
        const pricePerShare = r.int(100_000n, 3_000_000n); // $0.10 to $3.00
        claims.push({ preferred: { shares, preference: shares * pricePerShare } });
      }
    }
    const exit = r.chance(10) ? r.int(1n, 999n) * USD : r.int(1n, 200n) * 1_000_000n * USD + r.int(0n, 999_999n) * USD;
    out.push({ id, exit, common, claims });
  }
  return out;
}

// ---------- JSON in the contract's shape (u128 as strings) ----------
const s = (x: bigint) => x.toString();
export const capJson = (c: Cap) => ({ outstanding: s(c.outstanding), options: s(c.options), pool: s(c.pool) });
export const safeJson = (x: Safe) => ({ purchase: s(x.purchase), cap: x.cap === null ? null : s(x.cap), discount_bps: x.discount_bps });
export const termsJson = (t: Terms) => ({
  pre_money: s(t.pre_money),
  new_money: t.new_money.map(s),
  pool: "increase" in t.pool ? { increase: s(t.pool.increase) } : { target_bps: t.pool.target_bps },
  price_decimals: t.price_decimals,
});
export const claimJson = (c: Claim) =>
  "safe" in c ? { safe: { purchase: s(c.safe.purchase), cap: c.safe.cap === null ? null : s(c.safe.cap) } } : { preferred: { shares: s(c.preferred.shares), preference: s(c.preferred.preference) } };
export const capFromJson = (c: any): Cap => ({ outstanding: BigInt(c.outstanding), options: BigInt(c.options), pool: BigInt(c.pool) });
export const safeFromJson = (x: any): Safe => ({ purchase: BigInt(x.purchase), cap: x.cap == null ? null : BigInt(x.cap), discount_bps: x.discount_bps ?? 0 });
export const termsFromJson = (t: any): Terms => ({
  pre_money: BigInt(t.pre_money),
  new_money: t.new_money.map(BigInt),
  pool: "increase" in t.pool ? { increase: BigInt(t.pool.increase) } : { target_bps: t.pool.target_bps },
  price_decimals: t.price_decimals,
});
/** A Conversion with bigints as strings, in the contract's field names. */
export const conversionJson = (c: any) => ({
  price: s(c.price),
  company_capitalization: s(c.company_capitalization),
  safes: c.safes.map((r: any) => ({ shares: s(r.shares), basis: r.basis, other_basis_shares: s(r.other_basis_shares) })),
  safe_shares: s(c.safe_shares),
  pool_increase: s(c.pool_increase),
  pool_after: s(c.pool_after),
  new_shares: c.new_shares.map(s),
  new_shares_total: s(c.new_shares_total),
  pre_money_shares: s(c.pre_money_shares),
  post_money_shares: s(c.post_money_shares),
});
