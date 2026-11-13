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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SafeShares {
    #[serde(with = "dec")]
    pub shares: u128,
    pub basis: Basis,
    /// What the other basis would have given (0 for an uncapped SAFE, which has no Safe Price).
    #[serde(with = "dec")]
    pub other_basis_shares: u128,
}

/// The whole result of a priced round, every number a whole number of shares or micro-dollars.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
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
    to_u128(&((big(a) * big(b)) / big(c)))
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
    let alpha = safes.iter().filter_map(|s| s.cap.map(|c| Q::frac(s.purchase, c))).fold(Q::int(0), |a, r| a.add(&r));
    if alpha.cmp(&Q::int(1)) != Ordering::Less {
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
fn exact_price(c: u128, cap: &Cap, safes: &[Safe], order: &[usize], t: &Priced) -> Result<Q, &'static str> {
    let uncapped = safes.iter().filter(|s| s.cap.is_none()).count();
    let pre = Q::int(t.pre_money);
    let post = Q::int(add(t.pre_money, sum(t.new_money.iter().copied())?)?);
    let cq = Q::int(c);
    let u0 = Q::int(cap.pool);
    for j in uncapped..=safes.len() {
        let in_b = |i: usize| order[..j].contains(&i);
        let mut alpha = Q::int(0);
        let mut beta = Q::int(0);
        for (i, s) in safes.iter().enumerate() {
            if in_b(i) {
                beta = beta.add(&Q::frac(s.purchase * BPS, BPS - s.discount_bps as u128));
            } else if let Some(cp) = s.cap {
                alpha = alpha.add(&Q::frac(s.purchase, cp));
            }
        }
        let om = Q::int(1).sub(&alpha);
        let with_increase = |inc: u128| om.mul(&pre).sub(&beta).div(&cq.add(&om.mul(&Q::int(inc))));
        let p = match t.pool {
            Pool::Increase(inc) => with_increase(inc),
            Pool::TargetBps(qb) => {
                let q = Q::frac(qb as u128, BPS);
                let num = om.mul(&pre.sub(&q.mul(&post))).sub(&beta);
                let den = cq.sub(&om.mul(&u0));
                let p = num.div(&den);
                // The pool is already big enough: no increase.
                if p.is_pos() && q.mul(&post).div(&p).cmp(&u0) == Ordering::Less {
                    with_increase(0)
                } else {
                    p
                }
            }
        };
        if !p.is_pos() {
            continue;
        }
        let k = cq.add(&beta.div(&p)).div(&om);
        let pk = p.mul(&k);
        let consistent = safes.iter().enumerate().all(|(i, s)| match s.cap {
            None => true,
            Some(cp) => {
                let v = Q::frac(cp * BPS, BPS - s.discount_bps as u128);
                if in_b(i) {
                    v.cmp(&pk) == Ordering::Greater
                } else {
                    v.cmp(&pk) != Ordering::Greater
                }
            }
        });
        if consistent {
            return Ok(p);
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
    let mut in_b: Vec<bool> = safes.iter().map(|s| s.cap.is_none()).collect();
    // Company Capitalization = (existing + shares of SAFEs at the price) / (1 - sum of purchase/cap over SAFEs at their caps), rounded down.
    let company_cap = |in_b: &[bool]| -> Result<u128, &'static str> {
        let mut num = c;
        let mut alpha = Q::int(0);
        for (i, s) in safes.iter().enumerate() {
            if in_b[i] {
                num = add(num, at_price[i])?;
            } else if let Some(cp) = s.cap {
                alpha = alpha.add(&Q::frac(s.purchase, cp));
            }
        }
        to_u128(&Q::int(num).div(&Q::int(1).sub(&alpha)).floor())
    };
    for &i in order {
        let Some(cp) = safes[i].cap else { continue };
        let k = company_cap(&in_b)?;
        if at_price[i] > mul_div(k, safes[i].purchase, cp)? {
            in_b[i] = true;
        }
    }
    let k = company_cap(&in_b)?;
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ClaimPayout {
    pub converts: bool,
    /// Shares it holds as common in the sale (a converting SAFE's Conversion Amount in shares).
    #[serde(with = "dec")]
    pub shares: u128,
    #[serde(with = "dec")]
    pub payout: u128,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
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

fn split(exit: u128, common: u128, claims: &[Claim], conv: &[bool]) -> Result<Split, &'static str> {
    // Liquidity Capitalization = (common + converting preferred) / (1 - sum of purchase/cap over converting SAFEs), rounded down.
    let mut base = common;
    let mut alpha = Q::int(0);
    let mut prefs = 0u128;
    for (i, cl) in claims.iter().enumerate() {
        match (cl, conv[i]) {
            (Claim::Preferred { shares, .. }, true) => base = add(base, *shares)?,
            (Claim::Safe { purchase, cap: Some(cp) }, true) => alpha = alpha.add(&Q::frac(*purchase, *cp)),
            (Claim::Safe { purchase, .. }, false) => prefs = add(prefs, *purchase)?,
            (Claim::Preferred { preference, .. }, false) => prefs = add(prefs, *preference)?,
            (Claim::Safe { cap: None, .. }, true) => return Err("an uncapped SAFE takes its cash-out amount"),
        }
    }
    let one = Q::int(1);
    if alpha.cmp(&one) != Ordering::Less {
        return Err("at their caps the SAFEs would own 100% or more of the company");
    }
    let lk = to_u128(&Q::int(base).div(&one.sub(&alpha)).floor())?;
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
    let mut conv = vec![false; claims.len()];
    for _ in 0..(4 * claims.len() + 4) {
        let mut changed = false;
        for i in 0..claims.len() {
            if !can_convert(&claims[i]) {
                continue;
            }
            let mut with = conv.clone();
            with[i] = true;
            let mut without = conv.clone();
            without[i] = false;
            let wants = split(exit, common, claims, &with)?.pay[i] > split(exit, common, claims, &without)?.pay[i];
            if wants != conv[i] {
                conv[i] = wants;
                changed = true;
            }
        }
        if !changed {
            let s = split(exit, common, claims, &conv)?;
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
