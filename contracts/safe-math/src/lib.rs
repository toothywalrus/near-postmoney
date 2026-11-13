//! The arithmetic of a post-money SAFE, exactly.
//!
//! Three things a founder's spreadsheet gets wrong, done here in exact integer and rational arithmetic
//! (big integers, no floating point anywhere):
//!
//! 1. [`convert`]: a priced round converts every outstanding post-money SAFE. The SAFE's "Company
//!    Capitalization" includes the SAFEs themselves (a circular definition), the round's price per share
//!    depends on how many shares the SAFEs become (another circle), and the option pool top-up depends on
//!    the price (a third). The rules, and the rounding rule for whole shares, are in
//!    `docs/decisions/0002-conversion-rounding.md`.
//! 2. [`waterfall`]: who gets what when the company is sold, with SAFEs (cash-out or conversion, whichever
//!    is greater) and 1x non-participating preferred stock.
//! 3. The independent reference these are tested against is `ref/reference.ts` (BigInt fractions, brute force
//!    over every mode assignment). This crate never imports it, and it never imports this crate.
//!
//! Units: money is in micro-dollars (USDC has 6 decimals), shares are whole shares, rates are basis points.
use core::cmp::Ordering;
use num_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use serde::{Deserialize, Serialize};

/// Basis points in one.
pub const BPS: u128 = 10_000;
/// Money unit: one micro-dollar (USDC's 6 decimals).
pub const MICRO: u128 = 1_000_000;

/// One outstanding post-money SAFE, as the conversion sees it (an MFN SAFE arrives with the terms it adopted).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Safe {
    /// Purchase Amount, micro-dollars.
    #[serde(with = "dec")]
    pub purchase: u128,
    /// Post-Money Valuation Cap, micro-dollars. None: no cap (a discount-only or MFN SAFE).
    #[serde(with = "opt_dec", default)]
    pub cap: Option<u128>,
    /// The discount in basis points (2000 = 20% off, so a Discount Rate of 80%). 0: none.
    #[serde(default)]
    pub discount_bps: u32,
}

/// The capitalization immediately before the priced round, in shares.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct Cap {
    /// Capital stock issued and outstanding, as converted to common (common plus any preferred).
    #[serde(with = "dec")]
    pub outstanding: u128,
    /// Issued and outstanding options, plus promised options.
    #[serde(with = "dec")]
    pub options: u128,
    /// The unissued option pool before the round's increase.
    #[serde(with = "dec")]
    pub pool: u128,
}

/// How the round sizes the option pool.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Pool {
    /// The term sheet names the increase in shares (as in YC's worked examples).
    Increase(#[serde(with = "dec")] u128),
    /// The unissued pool must be at least this share of the post-money fully diluted capitalization.
    TargetBps(u32),
}

/// The priced round's terms.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Priced {
    /// Pre-money valuation, micro-dollars. Includes the SAFEs' conversion shares and the pool increase.
    #[serde(with = "dec")]
    pub pre_money: u128,
    /// Each new-money investor's cash, micro-dollars, in order.
    #[serde(with = "dec_vec")]
    pub new_money: Vec<u128>,
    pub pool: Pool,
    /// The price per share is rounded half-up to this many decimals of a dollar (YC's examples use 4).
    pub price_decimals: u8,
}

/// Which price a SAFE converted at.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// The Safe Price: Post-Money Valuation Cap / Company Capitalization (Safe Preferred Stock).
    Cap,
    /// The round's price per share, times the Discount Rate if the SAFE has a discount.
    Price,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SafeShares {
    #[serde(with = "dec")]
    pub shares: u128,
    pub basis: Basis,
    /// What the other basis would have given (0 for an uncapped SAFE, which has no Safe Price).
    #[serde(with = "dec")]
    pub other_basis_shares: u128,
}

/// The whole result of a priced round, every number a whole number of shares or micro-dollars.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Conversion {
    /// Price per share, micro-dollars, rounded to the round's decimals.
    #[serde(with = "dec")]
    pub price: u128,
    /// The exact solution before rounding, micro-dollars per share, as "numerator/denominator".
    pub exact_price: String,
    /// Company Capitalization (shares), rounded down, as the SAFE defines it.
    #[serde(with = "dec")]
    pub company_capitalization: u128,
    pub safes: Vec<SafeShares>,
    #[serde(with = "dec")]
    pub safe_shares: u128,
    #[serde(with = "dec")]
    pub pool_increase: u128,
    #[serde(with = "dec")]
    pub pool_after: u128,
    #[serde(with = "dec_vec")]
    pub new_shares: Vec<u128>,
    #[serde(with = "dec")]
    pub new_shares_total: u128,
    /// Fully diluted shares the pre-money valuation buys: existing + SAFE conversion + pool increase.
    #[serde(with = "dec")]
    pub pre_money_shares: u128,
    /// Fully diluted shares after the round.
    #[serde(with = "dec")]
    pub post_money_shares: u128,
}

// ---------- exact rationals over big integers ----------

#[derive(Clone, Debug)]
struct Q {
    n: BigInt,
    d: BigInt, // > 0
}

fn big(x: u128) -> BigInt {
    BigInt::from(x)
}

impl Q {
    fn int(x: u128) -> Q {
        Q { n: big(x), d: BigInt::one() }
    }
    fn new(n: BigInt, d: BigInt) -> Q {
        let (n, d) = if d.is_negative() { (-n, -d) } else { (n, d) };
        let g = n.gcd(&d);
        if g.is_zero() || g.is_one() {
            Q { n, d }
        } else {
            Q { n: n / &g, d: d / g }
        }
    }
    fn frac(n: u128, d: u128) -> Q {
        Q::new(big(n), big(d))
    }
    fn add(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.d + &o.n * &self.d, &self.d * &o.d)
    }
    fn sub(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.d - &o.n * &self.d, &self.d * &o.d)
    }
    fn mul(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.n, &self.d * &o.d)
    }
    fn div(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.d, &self.d * &o.n)
    }
    fn is_pos(&self) -> bool {
        self.n.is_positive()
    }
    fn cmp(&self, o: &Q) -> Ordering {
        (&self.n * &o.d).cmp(&(&o.n * &self.d))
    }
    fn floor(&self) -> BigInt {
        self.n.div_floor(&self.d)
    }
}

fn to_u128(x: &BigInt) -> Result<u128, &'static str> {
    x.to_u128().ok_or("a number is out of range")
}

/// floor(a * b / c) for u128s, exactly.
fn mul_div(a: u128, b: u128, c: u128) -> Result<u128, &'static str> {
    if c == 0 {
        return Err("division by zero");
    }
    match a.checked_mul(b) {
        Some(x) => Ok(x / c),
        None => to_u128(&((big(a) * big(b)) / big(c))),
    }
}

fn lcm(a: &BigInt, b: &BigInt) -> BigInt {
    a / a.gcd(b) * b
}

/// Common denominators for the SAFEs' two sums, so the hot loops add and subtract whole numbers (no gcd per step):
/// sum of purchase/cap = `na / d`, and sum of purchase/Discount Rate = `nb / e`.
struct Den {
    /// lcm of the caps.
    d: BigInt,
    /// lcm of (BPS - discount), times nothing else: purchase x BPS / (BPS - discount) = purchase x BPS x (e / (BPS - discount)) / e.
    e: BigInt,
}

impl Den {
    fn of(safes: &[Safe]) -> Den {
        let mut d = BigInt::one();
        let mut e = BigInt::one();
        for s in safes {
            if let Some(cp) = s.cap {
                d = lcm(&d, &big(cp));
            }
            e = lcm(&e, &big(BPS - s.discount_bps as u128));
        }
        Den { d, e }
    }
    /// purchase / cap, over `d`.
    fn at_cap(&self, s: &Safe) -> BigInt {
        big(s.purchase) * (&self.d / big(s.cap.unwrap_or(1)))
    }
    /// purchase x BPS / (BPS - discount), over `e`.
    fn at_price(&self, s: &Safe) -> BigInt {
        big(s.purchase) * big(BPS) * (&self.e / big(BPS - s.discount_bps as u128))
    }
}

fn add(a: u128, b: u128) -> Result<u128, &'static str> {
    a.checked_add(b).ok_or("overflow")
}

fn sum(xs: impl IntoIterator<Item = u128>) -> Result<u128, &'static str> {
    xs.into_iter().try_fold(0u128, add)
}

/// SAFE i's "value" v_i = cap / Discount Rate: it converts at the round's price exactly when v_i > price x Company Capitalization.
/// Uncapped SAFEs are infinite (always at the price). Ordered high to low, ties by position.
fn order_by_value(safes: &[Safe]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..safes.len()).collect();
    order.sort_by(|&i, &j| {
        let (a, b) = (&safes[i], &safes[j]);
        let by = match (a.cap, b.cap) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            // cap_a/(BPS-d_a) vs cap_b/(BPS-d_b), descending
            (Some(ca), Some(cb)) => (big(cb) * big(BPS - a.discount_bps as u128)).cmp(&(big(ca) * big(BPS - b.discount_bps as u128))),
        };
        by.then(i.cmp(&j))
    });
    order
}

fn validate(cap: &Cap, safes: &[Safe], t: &Priced) -> Result<u128, &'static str> {
    if t.price_decimals > 6 {
        return Err("price_decimals must be 0 to 6");
    }
    if t.pre_money == 0 {
        return Err("pre-money valuation must be positive");
    }
    if t.new_money.is_empty() || t.new_money.iter().any(|&m| m == 0) {
        return Err("a priced round needs new money from at least one investor");
    }
    if let Pool::TargetBps(q) = t.pool {
        if q as u128 >= BPS {
            return Err("the pool target must be under 100%");
        }
    }
    for s in safes {
        if s.purchase == 0 {
            return Err("a SAFE has no purchase amount");
        }
        if s.cap == Some(0) {
            return Err("a SAFE's valuation cap must be positive");
        }
        if s.discount_bps as u128 >= BPS {
            return Err("a SAFE's discount must be under 100%");
        }
    }
    // At their caps the SAFEs must own less than all of the company.
    let den = Den::of(safes);
    let na: BigInt = safes.iter().filter(|s| s.cap.is_some()).map(|s| den.at_cap(s)).sum();
    if na >= den.d {
        return Err("at their caps the SAFEs would own 100% or more of the company");
    }
    let c = sum([cap.outstanding, cap.options, cap.pool])?;
    if c == 0 || c == cap.pool {
        return Err("the company has no shares outstanding");
    }
    Ok(c)
}

/// The exact price per share (micro-dollars, rational), with no rounding anywhere: the unique solution of
/// the three circular definitions, found by trying each threshold in the SAFEs' value order.
///
/// The SAFEs at the round's price are always the capped SAFEs of highest value (cap / Discount Rate), plus the uncapped
/// ones; SAFEs of equal value are always on the same side. So each threshold moves one group of equal value from "at
/// its cap" to "at the price": the two sums are updated in whole numbers over common denominators, and only the groups
/// either side of the threshold need checking (decision 0002). In whole numbers, with alpha = na/d and beta = nb/e:
///   fixed increase T:  price = ((d - na) pre e - nb d) / (e (C d + (d - na) T))
///   pool target q:     price = ((d - na)(pre BPS - q post) e - nb d BPS) / (BPS e (C d - (d - na) U0))
fn exact_price(c: u128, cap: &Cap, safes: &[Safe], order: &[usize], t: &Priced) -> Result<Q, &'static str> {
    let den = Den::of(safes);
    let (d, e) = (&den.d, &den.e);
    let pre = big(t.pre_money);
    let post = big(add(t.pre_money, sum(t.new_money.iter().copied())?)?);
    let cq = big(c);
    let u0 = big(cap.pool);
    let bps = big(BPS);
    // Capped SAFEs in value order, grouped by equal value.
    let same_value = |a: &Safe, b: &Safe| big(a.cap.unwrap_or(0)) * big(BPS - b.discount_bps as u128) == big(b.cap.unwrap_or(0)) * big(BPS - a.discount_bps as u128);
    let mut groups: Vec<Vec<usize>> = vec![];
    for &i in order.iter().filter(|&&i| safes[i].cap.is_some()) {
        match groups.last_mut() {
            Some(g) if same_value(&safes[g[0]], &safes[i]) => g.push(i),
            _ => groups.push(vec![i]),
        }
    }
    let mut na: BigInt = safes.iter().filter(|s| s.cap.is_some()).map(|s| den.at_cap(s)).sum();
    let mut nb: BigInt = safes.iter().filter(|s| s.cap.is_none()).map(|s| den.at_price(s)).sum();
    // cap / Discount Rate > price x Company Capitalization, i.e. cap BPS p.d e (d - na) > (BPS - disc)(p.n C e + nb p.d) d.
    let above = |s: &Safe, pn: &BigInt, pd: &BigInt, na: &BigInt, nb: &BigInt| {
        big(s.cap.unwrap_or(0)) * &bps * pd * e * (d - na) > big(BPS - s.discount_bps as u128) * (pn * &cq * e + nb * pd) * d
    };
    for g in 0..=groups.len() {
        let om = d - &na; // d x (1 - alpha), positive
        let with_increase = |inc: u128| ((&om * &pre * e - &nb * d), (e * (&cq * d + &om * big(inc))));
        let (pn, pd) = match t.pool {
            Pool::Increase(inc) => with_increase(inc),
            Pool::TargetBps(qb) => {
                let qb = big(qb as u128);
                let pn = &om * (&pre * &bps - &qb * &post) * e - &nb * d * &bps;
                let pd = &bps * e * (&cq * d - &om * &u0);
                // The pool is already big enough (q post / price < U0): no increase.
                if pn.is_positive() && &qb * &post * &pd < &u0 * &bps * &pn {
                    with_increase(0)
                } else {
                    (pn, pd)
                }
            }
        };
        if pn.is_positive() && pd.is_positive() {
            let last_in = g == 0 || above(&safes[groups[g - 1][0]], &pn, &pd, &na, &nb);
            let first_out = g == groups.len() || !above(&safes[groups[g][0]], &pn, &pd, &na, &nb);
            if last_in && first_out {
                return Ok(Q::new(pn, pd));
            }
        }
        if g < groups.len() {
            for &i in &groups[g] {
                na -= den.at_cap(&safes[i]);
                nb += den.at_price(&safes[i]);
            }
        }
    }
    Err("the pre-money valuation is too low to convert these SAFEs")
}

struct At {
    k: u128,
    out: Vec<SafeShares>,
    total: u128,
}

/// Every SAFE's whole shares at a given (rounded) price, each taking whichever basis gives more shares.
fn shares_at(c: u128, safes: &[Safe], order: &[usize], p: u128) -> Result<At, &'static str> {
    let at_price: Vec<u128> = safes
        .iter()
        .map(|s| mul_div(s.purchase, BPS, p.checked_mul(BPS - s.discount_bps as u128).ok_or("overflow")?))
        .collect::<Result<_, _>>()?;
    let den = Den::of(safes);
    let mut in_b: Vec<bool> = safes.iter().map(|s| s.cap.is_none()).collect();
    // Company Capitalization = (existing + shares of SAFEs at the price) / (1 - sum of purchase/cap over SAFEs at
    // their caps), rounded down: floor(num x d / (d - na)). Both sums change only when a SAFE moves to the price.
    let mut num = c;
    let mut na = BigInt::zero();
    for (i, s) in safes.iter().enumerate() {
        match s.cap {
            Some(_) => na += den.at_cap(s),
            None => num = add(num, at_price[i])?,
        }
    }
    let company_cap = |num: u128, na: &BigInt| to_u128(&((big(num) * &den.d) / (&den.d - na)));
    let mut k = company_cap(num, &na)?;
    for &i in order {
        let Some(cp) = safes[i].cap else { continue };
        if at_price[i] > mul_div(k, safes[i].purchase, cp)? {
            in_b[i] = true;
            num = add(num, at_price[i])?;
            na -= den.at_cap(&safes[i]);
            k = company_cap(num, &na)?;
        }
    }
    let mut out = Vec::with_capacity(safes.len());
    for (i, s) in safes.iter().enumerate() {
        let at_cap = match s.cap {
            Some(cp) => mul_div(k, s.purchase, cp)?,
            None => 0,
        };
        let row = if in_b[i] {
            if s.cap.is_some() && at_price[i] <= at_cap {
                return Err("the SAFEs' conversion bases do not settle at this price");
            }
            SafeShares { shares: at_price[i], basis: Basis::Price, other_basis_shares: at_cap }
        } else {
            if at_cap < at_price[i] {
                return Err("the SAFEs' conversion bases do not settle at this price");
            }
            SafeShares { shares: at_cap, basis: Basis::Cap, other_basis_shares: at_price[i] }
        };
        out.push(row);
    }
    let total = sum(out.iter().map(|r| r.shares))?;
    Ok(At { k, out, total })
}

/// Round a rational number of micro-dollars half-up to a multiple of `unit`.
fn round_to(n: &BigInt, d: &BigInt, unit: u128) -> Result<u128, &'static str> {
    let u = big(unit);
    let num: BigInt = n * BigInt::from(2) + &u * d;
    let den: BigInt = BigInt::from(2) * &u * d;
    let r = num.div_floor(&den);
    to_u128(&(r * u))
}

/// New-money shares: the round sells floor(total new money / price) shares. Each investor gets floor(cash / price)
/// except the last one listed, who gets the rest (fewer than one extra share per investor): YC's tables put the
/// residual on their last line, "other new investors".
pub fn allocate(new_money: &[u128], price: u128) -> Result<(Vec<u128>, u128), &'static str> {
    let total = sum(new_money.iter().copied())? / price;
    let mut shares: Vec<u128> = new_money.iter().map(|m| m / price).collect();
    let last = shares.len() - 1;
    shares[last] = total - sum(shares[..last].iter().copied())?;
    Ok((shares, total))
}

fn pool_increase(c: u128, pool: u128, terms: &Pool, s: u128, n: u128) -> Result<u128, &'static str> {
    match *terms {
        Pool::Increase(t) => Ok(t),
        // The smallest whole T with (pool + T) >= q x (c + s + n + T).
        Pool::TargetBps(q) => {
            let need = big(q as u128) * big(sum([c, s, n])?) - big(pool) * big(BPS);
            if !need.is_positive() {
                return Ok(0);
            }
            let den = big(BPS - q as u128);
            to_u128(&((need + &den - 1) / den))
        }
    }
}

/// Convert every SAFE at a priced round. See the module docs and decision 0002 for the rules: the exact
/// solution's price is rounded once, half-up, to the round's decimals, and every share count follows from
/// that rounded price (SAFE and new-money shares rounded down, a pool target rounded up to whole shares).
pub fn convert(cap: &Cap, safes: &[Safe], t: &Priced) -> Result<Conversion, &'static str> {
    let c = validate(cap, safes, t)?;
    let order = order_by_value(safes);
    let exact = exact_price(c, cap, safes, &order, t)?;
    let unit = 10u128.pow(6 - t.price_decimals as u32);
    let p = round_to(&exact.n, &exact.d, unit)?;
    if p == 0 {
        return Err("the price per share rounds to zero: use more decimals");
    }
    let at = shares_at(c, safes, &order, p)?;
    let (new_shares, n) = allocate(&t.new_money, p)?;
    let inc = pool_increase(c, cap.pool, &t.pool, at.total, n)?;
    let fd = sum([c, at.total, inc])?;
    Ok(Conversion {
        price: p,
        exact_price: format!("{}/{}", exact.n, exact.d),
        company_capitalization: at.k,
        safes: at.out,
        safe_shares: at.total,
        pool_increase: inc,
        pool_after: add(cap.pool, inc)?,
        new_shares,
        new_shares_total: n,
        pre_money_shares: fd,
        post_money_shares: add(fd, n)?,
    })
}

/// Before any priced round, with every capped SAFE at its cap: the Company Capitalization (rounded down) and each
/// SAFE's shares (uncapped SAFEs: 0, since they have no Safe Price). This is the "post-SAFE" cap table YC tabulates.
pub fn at_caps(c: u128, safes: &[Safe]) -> Result<(u128, Vec<u128>), &'static str> {
    let den = Den::of(safes);
    let na: BigInt = safes.iter().filter(|s| s.cap.is_some()).map(|s| den.at_cap(s)).sum();
    if na >= den.d {
        return Err("at their caps the SAFEs would own 100% or more of the company");
    }
    let k = to_u128(&((big(c) * &den.d) / (&den.d - na)))?;
    let shares = safes.iter().map(|s| s.cap.map_or(Ok(0), |cp| mul_div(k, s.purchase, cp))).collect::<Result<_, _>>()?;
    Ok((k, shares))
}

// ---------- the exit waterfall ----------

/// One claimant in a sale: a SAFE (cash-out or conversion) or a series of 1x non-participating preferred.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Claim {
    /// An outstanding SAFE. Capped: the greater of its Cash-Out Amount (its purchase) and its Conversion
    /// Amount at Cap / Liquidity Capitalization. Uncapped: its Cash-Out Amount (see decision 0003).
    Safe {
        #[serde(with = "dec")]
        purchase: u128,
        #[serde(with = "opt_dec", default)]
        cap: Option<u128>,
    },
    /// A preferred series: its 1x liquidation amount, or its shares as common, whichever is greater.
    Preferred {
        #[serde(with = "dec")]
        shares: u128,
        #[serde(with = "dec")]
        preference: u128,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ClaimPayout {
    pub converts: bool,
    /// Shares it holds as common in the sale (a converting SAFE's Conversion Amount in shares).
    #[serde(with = "dec")]
    pub shares: u128,
    #[serde(with = "dec")]
    pub payout: u128,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Waterfall {
    #[serde(with = "dec")]
    pub exit: u128,
    pub claims: Vec<ClaimPayout>,
    /// Common stock and outstanding options (as exercised), in shares.
    #[serde(with = "dec")]
    pub common_shares: u128,
    #[serde(with = "dec")]
    pub common_payout: u128,
    /// The Liquidity Capitalization: every share taking part as common.
    #[serde(with = "dec")]
    pub as_converted_shares: u128,
    /// Micro-dollars left by rounding each payout down.
    #[serde(with = "dec")]
    pub dust: u128,
}

struct Split {
    shares: Vec<u128>,
    pay: Vec<u128>,
    common_pay: u128,
    total_shares: u128,
}

/// The capped SAFE claims' purchase/cap over a common denominator `d`, computed once per waterfall.
struct Terms {
    d: BigInt,
    at_cap: Vec<BigInt>,
}

fn terms_of(claims: &[Claim]) -> Terms {
    let mut d = BigInt::one();
    for cl in claims {
        if let Claim::Safe { cap: Some(cp), .. } = cl {
            d = lcm(&d, &big(*cp));
        }
    }
    let at_cap = claims
        .iter()
        .map(|cl| match cl {
            Claim::Safe { purchase, cap: Some(cp) } => big(*purchase) * (&d / big(*cp)),
            _ => BigInt::zero(),
        })
        .collect();
    Terms { d, at_cap }
}

fn split(exit: u128, common: u128, claims: &[Claim], terms: &Terms, conv: &[bool]) -> Result<Split, &'static str> {
    // Liquidity Capitalization = (common + converting preferred) / (1 - sum of purchase/cap over converting SAFEs), rounded down.
    let mut base = common;
    let mut na = BigInt::zero();
    let mut prefs = 0u128;
    for (i, cl) in claims.iter().enumerate() {
        match (cl, conv[i]) {
            (Claim::Preferred { shares, .. }, true) => base = add(base, *shares)?,
            (Claim::Safe { cap: Some(_), .. }, true) => na += &terms.at_cap[i],
            (Claim::Safe { purchase, .. }, false) => prefs = add(prefs, *purchase)?,
            (Claim::Preferred { preference, .. }, false) => prefs = add(prefs, *preference)?,
            (Claim::Safe { cap: None, .. }, true) => return Err("an uncapped SAFE takes its cash-out amount"),
        }
    }
    if na >= terms.d {
        return Err("at their caps the SAFEs would own 100% or more of the company");
    }
    let lk = to_u128(&((big(base) * &terms.d) / (&terms.d - na)))?;
    let shares: Vec<u128> = claims
        .iter()
        .enumerate()
        .map(|(i, cl)| match (cl, conv[i]) {
            (_, false) => Ok(0),
            (Claim::Preferred { shares, .. }, true) => Ok(*shares),
            (Claim::Safe { purchase, cap: Some(cp) }, true) => mul_div(lk, *purchase, *cp),
            _ => Err("unreachable"),
        })
        .collect::<Result<_, _>>()?;
    let total_shares = add(common, sum(shares.iter().copied())?)?;
    let pref_of = |cl: &Claim| match cl {
        Claim::Safe { purchase, .. } => *purchase,
        Claim::Preferred { preference, .. } => *preference,
    };
    let (pay, common_pay) = if exit <= prefs {
        // Not enough for the preferences: they share the exit pro rata, nothing for common.
        let pay = claims
            .iter()
            .enumerate()
            .map(|(i, cl)| if conv[i] { Ok(0) } else { mul_div(exit, pref_of(cl), prefs) })
            .collect::<Result<_, _>>()?;
        (pay, 0)
    } else {
        let rest = exit - prefs;
        let pay = claims
            .iter()
            .enumerate()
            .map(|(i, cl)| if conv[i] { mul_div(rest, shares[i], total_shares) } else { Ok(pref_of(cl)) })
            .collect::<Result<_, _>>()?;
        (pay, mul_div(rest, common, total_shares)?)
    };
    Ok(Split { shares, pay, common_pay, total_shares })
}

fn can_convert(cl: &Claim) -> bool {
    !matches!(cl, Claim::Safe { cap: None, .. })
}

/// Who gets what for a sale at `exit` micro-dollars. Each claimant converts exactly when converting pays it
/// strictly more, given everyone else's choice; the stable choice is found by best response.
pub fn waterfall(exit: u128, common: u128, claims: &[Claim]) -> Result<Waterfall, &'static str> {
    if common == 0 && claims.is_empty() {
        return Err("nobody holds anything");
    }
    let terms = terms_of(claims);
    let mut conv = vec![false; claims.len()];
    let mut cur = split(exit, common, claims, &terms, &conv)?;
    for _ in 0..(4 * claims.len() + 4) {
        let mut changed = false;
        for i in 0..claims.len() {
            if !can_convert(&claims[i]) {
                continue;
            }
            // The current choice's payout is `cur`'s; only the other choice needs a new split.
            let mut flipped = conv.clone();
            flipped[i] = !conv[i];
            let alt = split(exit, common, claims, &terms, &flipped)?;
            let (with, without) = if conv[i] { (cur.pay[i], alt.pay[i]) } else { (alt.pay[i], cur.pay[i]) };
            let wants = with > without;
            if wants != conv[i] {
                conv = flipped;
                cur = alt;
                changed = true;
            }
        }
        if !changed {
            let s = cur;
            let paid = add(sum(s.pay.iter().copied())?, s.common_pay)?;
            return Ok(Waterfall {
                exit,
                claims: (0..claims.len()).map(|i| ClaimPayout { converts: conv[i], shares: s.shares[i], payout: s.pay[i] }).collect(),
                common_shares: common,
                common_payout: s.common_pay,
                as_converted_shares: s.total_shares,
                dust: exit.checked_sub(paid).ok_or("paid out more than the exit")?,
            });
        }
    }
    Err("the claimants' choices do not settle")
}

// ---------- u128 as decimal strings in JSON (JavaScript numbers lose precision above 2^53) ----------

pub mod dec {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(v)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let s = <alloc::string::String>::deserialize(d)?;
        s.parse().map_err(|_| D::Error::custom("expected a whole number as a string"))
    }
    extern crate alloc;
}

pub mod opt_dec {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    extern crate alloc;
    pub fn serialize<S: Serializer>(v: &Option<u128>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => s.collect_str(x),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u128>, D::Error> {
        let s = <Option<alloc::string::String>>::deserialize(d)?;
        s.map(|s| s.parse().map_err(|_| D::Error::custom("expected a whole number as a string"))).transpose()
    }
}

pub mod dec_vec {
    use serde::{de::Error, ser::SerializeSeq, Deserialize, Deserializer, Serializer};
    extern crate alloc;
    use alloc::{string::String, vec::Vec};
    pub fn serialize<S: Serializer>(v: &[u128], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(v.len()))?;
        for x in v {
            seq.serialize_element(&alloc::format!("{x}"))?;
        }
        seq.end()
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u128>, D::Error> {
        let v = <Vec<String>>::deserialize(d)?;
        v.iter().map(|s| s.parse().map_err(|_| D::Error::custom("expected whole numbers as strings"))).collect()
    }
}

#[cfg(test)]
mod tests;
