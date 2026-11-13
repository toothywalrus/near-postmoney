// The YC Post-Money SAFE User Guide's worked examples (Appendix II, Example 1), to the share. Source:
// "Post-Money Safe User Guide", Y Combinator, https://www.ycombinator.com/documents (the "SAFE User Guide" PDF).
// The same vectors, with page references, are in fixtures/yc-examples.json; ref/reference.ts checks them too.
use super::*;

const USD: u128 = MICRO;
fn usd(dollars: u128) -> u128 {
    dollars * USD
}
fn cents(c: u128) -> u128 {
    c * USD / 100
}

fn example1_cap() -> Cap {
    // Founders 9,250,000; options outstanding 300,000 + promised 350,000; options available 100,000.
    Cap { outstanding: 9_250_000, options: 650_000, pool: 100_000 }
}
fn example1_safes() -> Vec<Safe> {
    vec![
        Safe { purchase: usd(200_000), cap: Some(usd(4_000_000)), discount_bps: 0 }, // Investor A
        Safe { purchase: usd(800_000), cap: Some(usd(8_000_000)), discount_bps: 0 }, // Investor B
    ]
}

#[test]
fn yc_example_1_series_a() {
    // Question 2: $5m at $15m pre, pool increase 1,695,000 shares, price $1.1144.
    // New money: Investor C $4m, Investor B's pro rata "448,671 shares ... for $499,998.97", the rest to other new investors.
    let t = Priced {
        pre_money: usd(15_000_000),
        new_money: vec![usd(4_000_000), cents(49_999_897), usd(5_000_000) - usd(4_000_000) - cents(49_999_897)],
        pool: Pool::Increase(1_695_000),
        price_decimals: 4,
    };
    let r = convert(&example1_cap(), &example1_safes(), &t).unwrap();
    assert_eq!(r.company_capitalization, 11_764_705);
    assert_eq!(r.safes[0], SafeShares { shares: 588_235, basis: Basis::Cap, other_basis_shares: 179_468 });
    assert_eq!(r.safes[1].shares, 1_176_470);
    assert_eq!(r.safes[1].basis, Basis::Cap);
    assert_eq!(r.price, 1_114_400); // $1.1144
    assert_eq!(r.new_shares_total, 4_486_719);
    assert_eq!(r.new_shares, vec![3_589_375, 448_671, 448_673]);
    assert_eq!(r.pool_after, 1_795_000);
    assert_eq!(r.pre_money_shares, 11_764_705 + 1_695_000);
    assert_eq!(r.post_money_shares, 17_946_424);
}

#[test]
fn yc_example_1_series_seed_below_cap() {
    // Question 5: $2.2m at $8.8m pre, pool increase 1,573,000, price $0.6577. Investor B converts at the round's
    // price (1,216,360 shares) because that beats its Safe Price; Investor A's Company Capitalization then grows.
    let t = Priced {
        pre_money: usd(8_800_000),
        new_money: vec![usd(1_650_000), cents(22_659_936), usd(2_200_000) - usd(1_650_000) - cents(22_659_936)],
        pool: Pool::Increase(1_573_000),
        price_decimals: 4,
    };
    let r = convert(&example1_cap(), &example1_safes(), &t).unwrap();
    assert_eq!(r.price, 657_700); // $0.6577
    assert_eq!(r.safes[1].shares, 1_216_360);
    assert_eq!(r.safes[1].basis, Basis::Price);
    assert_eq!(r.company_capitalization, 11_806_694);
    assert_eq!(r.safes[0].shares, 590_334);
    assert_eq!(r.safes[0].basis, Basis::Cap);
    assert_eq!(r.new_shares_total, 3_344_990);
    assert_eq!(r.new_shares, vec![2_508_742, 344_533, 491_715]);
    assert_eq!(r.pool_after, 1_673_000);
    assert_eq!(r.post_money_shares, 16_724_684);
}

fn liq_claims() -> Vec<Claim> {
    example1_safes().into_iter().map(|s| Claim::Safe { purchase: s.purchase, cap: s.cap }).collect()
}

#[test]
fn yc_example_1_acquired_for_10m() {
    // Question 3: founders 9,250,000 + options outstanding 300,000 (promised options removed; the unissued pool is excluded).
    let w = waterfall(usd(10_000_000), 9_550_000, &liq_claims()).unwrap();
    assert!(w.claims.iter().all(|c| c.converts));
    assert_eq!(w.claims[0].shares, 561_764);
    assert_eq!(w.claims[1].shares, 1_123_529);
    assert_eq!(w.as_converted_shares, 11_235_293);
    // YC multiplies by a per-share price rounded to $0.8901 ($500,026 and $1,000,053); exact, rounded down to the micro-dollar:
    assert_eq!(w.claims[0].payout, mul_div(usd(10_000_000), 561_764, 11_235_293).unwrap());
    assert!(w.claims[0].payout > usd(200_000) && w.claims[1].payout > usd(800_000));
}

#[test]
fn yc_example_1_acquired_for_3m() {
    // Question 4: neither SAFE converts; each is paid back; "the remaining cash consideration of $2m is shared pro rata among all other stockholders".
    let w = waterfall(usd(3_000_000), 9_550_000, &liq_claims()).unwrap();
    assert!(w.claims.iter().all(|c| !c.converts));
    assert_eq!(w.claims[0].payout, usd(200_000));
    assert_eq!(w.claims[1].payout, usd(800_000));
    assert_eq!(w.common_payout, usd(2_000_000));
    assert_eq!(w.dust, 0);
}

#[test]
fn target_pool_without_safes() {
    // 9m common + 1m pool; $3m at $9m pre for a 10% post-money pool. Worked by hand: exact price $0.8666...,
    // rounded $0.8667; 3,461,405 new shares; pool increase the smallest whole number reaching 10%: 384,601.
    let cap = Cap { outstanding: 9_000_000, options: 0, pool: 1_000_000 };
    let t = Priced { pre_money: usd(9_000_000), new_money: vec![usd(3_000_000)], pool: Pool::TargetBps(1000), price_decimals: 4 };
    let r = convert(&cap, &[], &t).unwrap();
    assert_eq!(r.price, 866_700);
    assert_eq!(r.new_shares_total, 3_461_405);
    assert_eq!(r.pool_increase, 384_601);
    assert!(r.pool_after * BPS >= 1000 * r.post_money_shares);
    assert!((r.pool_after - 1) * BPS < 1000 * (r.post_money_shares - 1));
}

#[test]
fn discount_safe_converts_at_discounted_price() {
    // An uncapped 20% discount SAFE always converts at 80% of the round's price.
    let cap = Cap { outstanding: 9_000_000, options: 0, pool: 1_000_000 };
    let safes = vec![Safe { purchase: usd(500_000), cap: None, discount_bps: 2000 }];
    let t = Priced { pre_money: usd(12_000_000), new_money: vec![usd(3_000_000)], pool: Pool::Increase(0), price_decimals: 4 };
    let r = convert(&cap, &safes, &t).unwrap();
    assert_eq!(r.safes[0].basis, Basis::Price);
    assert_eq!(r.safes[0].shares, usd(500_000) * BPS / (r.price * 8000));
    // the price is consistent with the shares the pre-money buys
    assert_eq!(r.price, round_to(&big(t.pre_money), &big(r.pre_money_shares), 100).unwrap());
}

#[test]
fn refusals() {
    let cap = example1_cap();
    let t = Priced { pre_money: usd(15_000_000), new_money: vec![usd(1)], pool: Pool::Increase(0), price_decimals: 4 };
    let greedy = vec![Safe { purchase: usd(5_000_000), cap: Some(usd(5_000_000)), discount_bps: 0 }];
    assert_eq!(convert(&cap, &greedy, &t).unwrap_err(), "at their caps the SAFEs would own 100% or more of the company");
    assert!(convert(&cap, &[], &Priced { new_money: vec![], ..t.clone() }).is_err());
    assert!(convert(&cap, &[], &Priced { price_decimals: 7, ..t.clone() }).is_err());
    assert!(convert(&Cap::default(), &[], &t).is_err());
}

#[test]
fn json_shape() {
    let t: Priced = serde_json::from_str(r#"{"pre_money":"15000000000000","new_money":["5000000000000"],"pool":{"increase":"1695000"},"price_decimals":4}"#).unwrap();
    assert_eq!(t.pool, Pool::Increase(1_695_000));
    let t2: Priced = serde_json::from_str(r#"{"pre_money":"1","new_money":["1"],"pool":{"target_bps":1000},"price_decimals":4}"#).unwrap();
    assert_eq!(t2.pool, Pool::TargetBps(1000));
    let s: Safe = serde_json::from_str(r#"{"purchase":"5","cap":null}"#).unwrap();
    assert_eq!(s, Safe { purchase: 5, cap: None, discount_bps: 0 });
}

/// The reference's random cases (fixtures/cases.json, written by `npm run cases`): the crate must agree on every number.
#[test]
fn agrees_with_reference_cases() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/cases.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        eprintln!("no fixtures/cases.json yet");
        return;
    };
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    let mut n = 0;
    for case in &cases {
        let cap: Cap = serde_json::from_value(case["cap"].clone()).unwrap();
        let safes: Vec<Safe> = serde_json::from_value(case["safes"].clone()).unwrap();
        let t: Priced = serde_json::from_value(case["terms"].clone()).unwrap();
        let got = convert(&cap, &safes, &t);
        match &case["expect"] {
            serde_json::Value::String(err) => assert!(got.is_err(), "case {}: reference refused ({err}) but crate gave {:?}", case["id"], got),
            want => {
                let got = got.unwrap_or_else(|e| panic!("case {}: crate refused: {e}", case["id"]));
                let got = serde_json::to_value(&got).unwrap();
                for k in ["price", "company_capitalization", "safes", "safe_shares", "pool_increase", "new_shares", "post_money_shares"] {
                    assert_eq!(got[k], want[k], "case {} field {k}", case["id"]);
                }
            }
        }
        n += 1;
    }
    eprintln!("{n} reference cases agree");
}

/// The reference's random waterfalls (fixtures/waterfalls.json): every choice and payout must agree.
#[test]
fn agrees_with_reference_waterfalls() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/waterfalls.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        eprintln!("no fixtures/waterfalls.json yet");
        return;
    };
    let cases: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    for case in &cases {
        let exit: u128 = case["exit"].as_str().unwrap().parse().unwrap();
        let common: u128 = case["common"].as_str().unwrap().parse().unwrap();
        let claims: Vec<Claim> = serde_json::from_value(case["claims"].clone()).unwrap();
        let got = waterfall(exit, common, &claims);
        match &case["expect"] {
            serde_json::Value::String(err) => assert!(got.is_err(), "waterfall {}: reference refused ({err}) but crate gave {:?}", case["id"], got),
            want => {
                let got = serde_json::to_value(got.unwrap_or_else(|e| panic!("waterfall {}: crate refused: {e}", case["id"]))).unwrap();
                for k in ["claims", "common_payout", "as_converted_shares"] {
                    assert_eq!(got[k], want[k], "waterfall {} field {k}", case["id"]);
                }
            }
        }
    }
    eprintln!("{} reference waterfalls agree", cases.len());
}
