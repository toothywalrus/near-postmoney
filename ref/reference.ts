// An independent reference for post-money SAFE conversion and the exit waterfall, in exact BigInt fractions.
//
// It shares no code with the contract (contracts/safe-math) and solves the same definitions a different way:
//   - the exact solve sets up the SAFE's circular definitions as a 2x2 linear system in (Company Capitalization,
//     1/price) and solves it by Cramer's rule, for EVERY assignment of SAFEs to "cap" or "price", keeping the
//     assignments where each SAFE gets the greater number of shares (the contract tries thresholds in value order);
//   - the whole-share step also tries every assignment and keeps the consistent ones (the contract scans once);
//   - the waterfall tries every set of converting claimants and keeps the equilibria (the contract best-responds).
// When an assignment is not unique, the reference says so ("ambiguous") rather than guessing.
// The rules, including how each number is rounded, are in docs/decisions/0002-conversion-rounding.md.

export type Safe = { purchase: bigint; cap: bigint | null; discount_bps: number };
export type Cap = { outstanding: bigint; options: bigint; pool: bigint };
export type Pool = { increase: bigint } | { target_bps: number };
export type Terms = { pre_money: bigint; new_money: bigint[]; pool: Pool; price_decimals: number };
export type SafeShares = { shares: bigint; basis: "cap" | "price"; other_basis_shares: bigint };
export type Conversion = {
  price: bigint;
  exact_price: Frac;
  company_capitalization: bigint;
  safes: SafeShares[];
  safe_shares: bigint;
  pool_increase: bigint;
  pool_after: bigint;
  new_shares: bigint[];
  new_shares_total: bigint;
  pre_money_shares: bigint;
  post_money_shares: bigint;
};
export class Refused extends Error {}

const BPS = 10_000n;

// ---------- fractions ----------
export type Frac = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
export const F = (n: bigint, d = 1n): Frac => {
  if (d === 0n) throw new Refused("division by zero");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const add = (a: Frac, b: Frac) => F(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Frac, b: Frac) => F(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Frac, b: Frac) => F(a.n * b.n, a.d * b.d);
const div = (a: Frac, b: Frac) => F(a.n * b.d, a.d * b.n);
const cmp = (a: Frac, b: Frac) => {
  const x = a.n * b.d - b.n * a.d;
  return x > 0n ? 1 : x < 0n ? -1 : 0;
};
/** floor for non-negative and negative fractions alike */
export const floor = (a: Frac) => (a.n >= 0n ? a.n / a.d : -((-a.n + a.d - 1n) / a.d));
const ceil = (a: Frac) => -floor(F(-a.n, a.d));
const ZERO = F(0n);
const ONE = F(1n);

/** Every subset of [0, n) as a bitmask array. */
function* subsets(n: number): Generator<boolean[]> {
  for (let m = 0; m < 1 << n; m++) yield Array.from({ length: n }, (_, i) => ((m >> i) & 1) === 1);
}

/** Round a fraction of micro-dollars half-up to a multiple of `unit`. */
const roundTo = (x: Frac, unit: bigint) => floor(add(div(x, F(unit)), F(1n, 2n))) * unit;

function check(cap: Cap, safes: Safe[], t: Terms): bigint {
  if (t.price_decimals < 0 || t.price_decimals > 6) throw new Refused("price_decimals must be 0 to 6");
  if (t.pre_money <= 0n) throw new Refused("pre-money valuation must be positive");
  if (!t.new_money.length || t.new_money.some((m) => m <= 0n)) throw new Refused("a priced round needs new money");
  if ("target_bps" in t.pool && BigInt(t.pool.target_bps) >= BPS) throw new Refused("pool target must be under 100%");
  for (const s of safes) {
    if (s.purchase <= 0n || (s.cap !== null && s.cap <= 0n) || BigInt(s.discount_bps) >= BPS) throw new Refused("bad SAFE");
  }
  const atCaps = safes.filter((s) => s.cap !== null).reduce((a, s) => add(a, F(s.purchase, s.cap!)), ZERO);
  if (cmp(atCaps, ONE) >= 0) throw new Refused("SAFEs at their caps would own 100% or more");
  const c = cap.outstanding + cap.options + cap.pool;
  if (c === 0n || c === cap.pool) throw new Refused("no shares outstanding");
  return c;
}

/** The exact solution (no rounding): 1/price and Company Capitalization from a 2x2 linear system per assignment. */
function exactSolve(c: bigint, cap: Cap, safes: Safe[], t: Terms): Frac {
  const pre = F(t.pre_money);
  const post = F(t.pre_money + t.new_money.reduce((a, b) => a + b, 0n));
  const found: Frac[] = [];
  for (const atPrice of subsets(safes.length)) {
    if (safes.some((s, i) => s.cap === null && !atPrice[i])) continue;
    // Unknowns K (Company Capitalization) and y = 1/price.
    //   K = C + sum_{cap} K*P/Cap + sum_{price} y*P/DR          ->  a1*K + b1*y = c1
    //   pre*y = K + T  with T fixed (increase), or T = q*post*y - U0 (target)  ->  a2*K + b2*y = c2
    let alpha = ZERO;
    let beta = ZERO;
    safes.forEach((s, i) => {
      if (atPrice[i]) beta = add(beta, F(s.purchase * BPS, BPS - BigInt(s.discount_bps)));
      else alpha = add(alpha, F(s.purchase, s.cap!));
    });
    const solve = (pool: Pool) => {
      const [a1, b1, c1] = [sub(ONE, alpha), F(-beta.n, beta.d), F(c)];
      const [a2, b2, c2] = "increase" in pool
        ? [ONE, F(-pre.n, pre.d), F(-pool.increase)]
        : [ONE, sub(mul(F(BigInt(pool.target_bps), BPS), post), pre), F(cap.pool)];
      const det = sub(mul(a1, b2), mul(a2, b1));
      if (det.n === 0n) return null;
      const K = div(sub(mul(c1, b2), mul(c2, b1)), det);
      const y = div(sub(mul(a1, c2), mul(a2, c1)), det);
      return { K, y };
    };
    let sol = solve(t.pool);
    if (sol && "target_bps" in t.pool && cmp(sol.y, ZERO) > 0) {
      const T = sub(mul(mul(F(BigInt(t.pool.target_bps), BPS), post), sol.y), F(cap.pool));
      if (cmp(T, ZERO) < 0) sol = solve({ increase: 0n }); // the pool is already big enough
    }
    if (!sol || cmp(sol.y, ZERO) <= 0) continue;
    const { K, y } = sol;
    // Each SAFE must get the greater number of shares under this solution (ties go to the Safe Price).
    const ok = safes.every((s, i) => {
      if (s.cap === null) return true;
      const atCap = mul(K, F(s.purchase, s.cap));
      const atP = mul(y, F(s.purchase * BPS, BPS - BigInt(s.discount_bps)));
      return atPrice[i] ? cmp(atP, atCap) > 0 : cmp(atCap, atP) >= 0;
    });
    if (ok) found.push(div(ONE, y));
  }
  if (!found.length) throw new Refused("pre-money too low to convert these SAFEs");
  if (found.some((p) => cmp(p, found[0]) !== 0)) throw new Refused("ambiguous: several exact solutions");
  return found[0];
}

/** Whole shares at a rounded price: every assignment tried, the consistent one kept. */
function sharesAt(c: bigint, safes: Safe[], p: bigint): { K: bigint; rows: SafeShares[]; total: bigint } {
  const atPriceShares = safes.map((s) => (s.purchase * BPS) / (p * (BPS - BigInt(s.discount_bps))));
  const hits: { K: bigint; rows: SafeShares[] }[] = [];
  for (const atPrice of subsets(safes.length)) {
    if (safes.some((s, i) => s.cap === null && !atPrice[i])) continue;
    let num = c;
    let alpha = ZERO;
    safes.forEach((s, i) => {
      if (atPrice[i]) num += atPriceShares[i];
      else alpha = add(alpha, F(s.purchase, s.cap!));
    });
    const K = floor(div(F(num), sub(ONE, alpha)));
    const rows: SafeShares[] = [];
    let ok = true;
    safes.forEach((s, i) => {
      const atCap = s.cap === null ? 0n : (K * s.purchase) / s.cap;
      if (atPrice[i]) {
        if (s.cap !== null && !(atPriceShares[i] > atCap)) ok = false;
        rows.push({ shares: atPriceShares[i], basis: "price", other_basis_shares: atCap });
      } else {
        if (atCap < atPriceShares[i]) ok = false;
        rows.push({ shares: atCap, basis: "cap", other_basis_shares: atPriceShares[i] });
      }
    });
    if (ok) hits.push({ K, rows });
  }
  if (!hits.length) throw new Refused("no consistent conversion at this price");
  if (hits.length > 1) throw new Refused("ambiguous: several consistent conversions at this price");
  return { ...hits[0], total: hits[0].rows.reduce((a, r) => a + r.shares, 0n) };
}

export function convert(cap: Cap, safes: Safe[], t: Terms): Conversion {
  const c = check(cap, safes, t);
  const exact = exactSolve(c, cap, safes, t);
  const unit = 10n ** BigInt(6 - t.price_decimals);
  const p = roundTo(exact, unit);
  if (p <= 0n) throw new Refused("price rounds to zero");
  const { K, rows, total: S } = sharesAt(c, safes, p);
  const totalNew = t.new_money.reduce((a, b) => a + b, 0n);
  const N = totalNew / p;
  const newShares = t.new_money.map((m) => m / p);
  newShares[newShares.length - 1] = N - newShares.slice(0, -1).reduce((a, b) => a + b, 0n);
  // Pool: the stated increase, or the least whole number of shares that reaches the target share of the post-money.
  let T: bigint;
  if ("increase" in t.pool) T = t.pool.increase;
  else {
    const q = F(BigInt(t.pool.target_bps), BPS);
    // (U0 + T) >= q (C + S + N + T)  <=>  T >= (q (C + S + N) - U0) / (1 - q)
    const need = div(sub(mul(q, F(c + S + N)), F(cap.pool)), sub(ONE, q));
    T = cmp(need, ZERO) > 0 ? ceil(need) : 0n;
  }
  const fd = c + S + T;
  return { price: p, exact_price: exact, company_capitalization: K, safes: rows, safe_shares: S, pool_increase: T, pool_after: cap.pool + T,
    new_shares: newShares, new_shares_total: N, pre_money_shares: fd, post_money_shares: fd + N };
}

// ---------- waterfall ----------
export type Claim = { safe: { purchase: bigint; cap: bigint | null } } | { preferred: { shares: bigint; preference: bigint } };
export type Waterfall = { claims: { converts: boolean; shares: bigint; payout: bigint }[]; common_payout: bigint; as_converted_shares: bigint };

function payouts(exit: bigint, common: bigint, claims: Claim[], conv: boolean[]) {
  let base = common;
  let alpha = ZERO;
  let prefs = 0n;
  claims.forEach((cl, i) => {
    if ("preferred" in cl) conv[i] ? (base += cl.preferred.shares) : (prefs += cl.preferred.preference);
    else if (conv[i]) alpha = add(alpha, F(cl.safe.purchase, cl.safe.cap!));
    else prefs += cl.safe.purchase;
  });
  const LK = floor(div(F(base), sub(ONE, alpha)));
  const shares = claims.map((cl, i) => (!conv[i] ? 0n : "preferred" in cl ? cl.preferred.shares : (LK * cl.safe.purchase) / cl.safe.cap!));
  const total = common + shares.reduce((a, b) => a + b, 0n);
  const pref = (cl: Claim) => ("preferred" in cl ? cl.preferred.preference : cl.safe.purchase);
  if (exit <= prefs) return { shares, total, pay: claims.map((cl, i) => (conv[i] ? 0n : (exit * pref(cl)) / prefs)), common_pay: 0n };
  const rest = exit - prefs;
  return { shares, total, pay: claims.map((cl, i) => (conv[i] ? (rest * shares[i]) / total : pref(cl))), common_pay: (rest * common) / total };
}

export function waterfall(exit: bigint, common: bigint, claims: Claim[]): Waterfall {
  const canConvert = (cl: Claim) => "preferred" in cl || cl.safe.cap !== null;
  const eq: boolean[][] = [];
  for (const conv of subsets(claims.length)) {
    if (claims.some((cl, i) => conv[i] && !canConvert(cl))) continue;
    const stable = claims.every((cl, i) => {
      if (!canConvert(cl)) return true;
      const yes = payouts(exit, common, claims, conv.map((v, j) => (j === i ? true : v))).pay[i];
      const no = payouts(exit, common, claims, conv.map((v, j) => (j === i ? false : v))).pay[i];
      return conv[i] === yes > no;
    });
    if (stable) eq.push(conv);
  }
  if (eq.length !== 1) throw new Refused(eq.length ? "ambiguous: several equilibria" : "no equilibrium");
  const r = payouts(exit, common, claims, eq[0]);
  return { claims: claims.map((_, i) => ({ converts: eq[0][i], shares: r.shares[i], payout: r.pay[i] })), common_payout: r.common_pay, as_converted_shares: r.total };
}
