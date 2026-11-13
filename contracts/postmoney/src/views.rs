//! Read-only views: the cap table, the rounds, the SAFE certificates (NEP-171/177/181), the priced-round preview,
//! the exit waterfall, and stateless calculators the property tests and the web page call.
use crate::*;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NewInvestor {
    pub account: AccountId,
    /// Cash, micro-dollars.
    pub cash: U128,
}

/// What the board proposes for a priced round.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PricedTerms {
    /// The series, e.g. "Series A".
    pub name: String,
    pub pre_money: U128,
    pub investors: Vec<NewInvestor>,
    pub pool: Pool,
    pub price_decimals: u8,
}

#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PreviewSafe {
    pub token_id: TokenId,
    pub owner: AccountId,
    pub round: u32,
    pub purchase: U128,
    pub discount_bps: u32,
    pub shares: U128,
    pub basis: Basis,
    pub other_basis_shares: U128,
    /// With a pro rata side letter: the most new shares it may buy to keep its ownership (floor of round x its share).
    pub pro_rata_shares: Option<U128>,
}

#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PreviewInvestor {
    pub account: AccountId,
    pub cash: U128,
    pub shares: U128,
}

#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Preview {
    pub name: String,
    pub version: U64,
    /// sha256 of (version, terms, result): the board's proposal carries it, and execution refuses any other.
    pub state_hash: String,
    pub price: U128,
    pub conversion: math::Conversion,
    pub safes: Vec<PreviewSafe>,
    pub investors: Vec<PreviewInvestor>,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Line {
    pub holder: String,
    pub label: String,
    pub shares: U128,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CapTable {
    pub company: String,
    pub board: AccountId,
    pub treasury: AccountId,
    pub usdc: AccountId,
    pub version: U64,
    pub classes: Vec<Class>,
    pub positions: Vec<Position>,
    pub options: U128,
    pub pool: U128,
    pub certificates: Vec<Certificate>,
    /// Fully diluted, with every capped SAFE at its cap (the post-money SAFE's promise): YC's "post-SAFE" table.
    pub company_capitalization: U128,
    pub as_converted: Vec<Line>,
    /// SAFEs with no cap: their shares are known only at the priced round.
    pub uncapped_safes: Vec<TokenId>,
    /// The board's right-of-first-refusal window, seconds.
    pub rofr_secs: U64,
    /// Money owed from a failed transfer, claimable with withdraw_owed.
    pub owed: Vec<(AccountId, U128)>,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Payout {
    pub holder: String,
    pub label: String,
    pub converts: bool,
    pub shares: U128,
    pub payout: U128,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct WaterfallView {
    pub exit: U128,
    pub lines: Vec<Payout>,
    pub detail: math::Waterfall,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Empty {}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenMetadata {
    pub title: String,
    pub description: String,
    pub media: String,
    pub copies: u64,
    pub issued_at: String,
    /// The SAFE's terms as JSON.
    pub extra: String,
}

/// NEP-171 token view.
#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct JsonToken {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
    pub approved_account_ids: Empty,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct NftMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// $1,234,567.89 from micro-dollars (cents shown only when there are any).
pub fn usd(micro: u128) -> String {
    let dollars = micro / 1_000_000;
    let cents = (micro % 1_000_000) / 10_000;
    let d = dollars.to_string();
    let mut out = String::new();
    for (i, ch) in d.chars().enumerate() {
        if i > 0 && (d.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if cents > 0 {
        format!("${out}.{cents:02}")
    } else {
        format!("${out}")
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('\'', "&apos;").replace('"', "&quot;")
}

fn terms_line(t: &SafeTerms) -> String {
    let mut parts = vec![];
    match t.cap {
        Some(c) => parts.push(format!("{} post-money cap", usd(c.0))),
        None => parts.push("no valuation cap".into()),
    }
    if t.discount_bps > 0 {
        let (whole, frac) = (t.discount_bps / 100, t.discount_bps % 100);
        parts.push(if frac == 0 { format!("{whole}% discount") } else { format!("{whole}.{frac:02}% discount") });
    }
    if t.mfn {
        parts.push("MFN".into());
    }
    if t.pro_rata {
        parts.push("pro rata".into());
    }
    parts.join(" · ")
}

impl Postmoney {
    pub(crate) fn preview(&self, terms: &PricedTerms) -> Preview {
        require!(!terms.name.is_empty() && terms.name.len() <= 40, "name the series (40 characters at most)");
        let priced = math::Priced { pre_money: terms.pre_money.0, new_money: terms.investors.iter().map(|i| i.cash.0).collect(), pool: terms.pool.clone(), price_decimals: terms.price_decimals };
        let conv = ok(math::convert(&self.cap_input(), &self.safe_inputs(), &priced));
        let base = sub(conv.pre_money_shares, conv.pool_increase); // existing + SAFE shares
        let safes = self
            .certs
            .iter()
            .zip(conv.safes.iter())
            .map(|(c, r)| PreviewSafe {
                token_id: c.token_id.clone(),
                owner: c.owner.clone(),
                round: c.round,
                purchase: c.purchase,
                discount_bps: c.terms.discount_bps,
                shares: U128(r.shares),
                basis: r.basis,
                other_basis_shares: U128(r.other_basis_shares),
                pro_rata_shares: c.terms.pro_rata.then(|| U128(ok(math_mul_div(conv.new_shares_total, r.shares, base)))),
            })
            .collect();
        let investors = terms.investors.iter().zip(conv.new_shares.iter()).map(|(i, &n)| PreviewInvestor { account: i.account.clone(), cash: i.cash, shares: U128(n) }).collect();
        let hashed = format!("{}|{}|{}", self.version, serde_json::to_string(terms).unwrap_or_default(), serde_json::to_string(&conv).unwrap_or_default());
        Preview { name: terms.name.clone(), version: U64(self.version), state_hash: hex(&env::sha256(hashed.as_bytes())), price: U128(conv.price), conversion: conv, safes, investors }
    }

    fn token_json(&self, c: &Certificate) -> JsonToken {
        let round_name = self.rounds.get(c.round as usize).map(|r| r.terms.name.clone()).unwrap_or_default();
        let title = format!("SAFE #{} · {} · {}", c.token_id, usd(c.purchase.0), terms_line(&c.terms));
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 360'><rect width='600' height='360' fill='#f4efe4'/><rect x='14' y='14' width='572' height='332' fill='none' stroke='#1f2a24' stroke-width='2'/><rect x='22' y='22' width='556' height='316' fill='none' stroke='#1f2a24' stroke-width='.6'/><g font-family='Georgia,serif' text-anchor='middle' fill='#1f2a24'><text x='300' y='66' font-size='12' letter-spacing='4'>SIMPLE AGREEMENT FOR FUTURE EQUITY</text><text x='300' y='112' font-size='28'>{}</text><text x='300' y='182' font-size='46' fill='#8a3a1f'>{}</text><text x='300' y='220' font-size='15'>{}</text><text x='300' y='278' font-size='13'>held by {}</text><text x='300' y='312' font-size='11' letter-spacing='1'>No. {} · {} · Postmoney on NEAR</text></g></svg>",
            esc(&self.company),
            usd(c.purchase.0),
            esc(&terms_line(&c.terms)),
            esc(c.owner.as_str()),
            c.token_id,
            esc(&round_name)
        );
        let media = format!("data:image/svg+xml;utf8,{}", svg.replace('%', "%25").replace('#', "%23").replace('<', "%3C").replace('>', "%3E"));
        JsonToken {
            token_id: c.token_id.clone(),
            owner_id: c.owner.clone(),
            metadata: TokenMetadata {
                title,
                description: format!("A post-money SAFE issued by {} in {}. It converts automatically at the company's next priced round (the contract computes the shares) or pays out in a sale. It moves only with the board's consent.", self.company, round_name),
                media,
                copies: 1,
                issued_at: (c.issued.0 * 1000).to_string(),
                extra: crate::obj!("purchase": c.purchase, "cap": c.terms.cap, "discount_bps": c.terms.discount_bps, "mfn": c.terms.mfn, "pro_rata": c.terms.pro_rata, "round": c.round, "amended_from_round": c.amended_from_round),
            },
            approved_account_ids: Empty {},
        }
    }
}

#[near]
impl Postmoney {
    pub fn cap_table(&self) -> CapTable {
        let cap = self.cap_input();
        let c = cap.outstanding + cap.options + cap.pool;
        let (k, safe_shares) = ok(math::at_caps(c, &self.safe_inputs()));
        let mut lines: Vec<Line> = self
            .positions
            .iter()
            .map(|p| Line { holder: p.holder.to_string(), label: self.classes[p.class as usize].name.clone(), shares: p.shares })
            .collect();
        for (cert, &n) in self.certs.iter().zip(safe_shares.iter()) {
            if cert.terms.cap.is_some() {
                lines.push(Line { holder: cert.owner.to_string(), label: format!("SAFE #{} (at its cap)", cert.token_id), shares: U128(n) });
            }
        }
        if self.options > 0 {
            lines.push(Line { holder: "options".into(), label: "Options issued and promised".into(), shares: U128(self.options) });
        }
        if self.pool > 0 {
            lines.push(Line { holder: "pool".into(), label: "Unissued option pool".into(), shares: U128(self.pool) });
        }
        CapTable {
            company: self.company.clone(),
            board: self.owner.clone(),
            treasury: self.treasury.clone(),
            usdc: self.usdc.clone(),
            version: U64(self.version),
            classes: self.classes.clone(),
            positions: self.positions.clone(),
            options: U128(self.options),
            pool: U128(self.pool),
            certificates: self.certs.clone(),
            company_capitalization: U128(k),
            as_converted: lines,
            uncapped_safes: self.certs.iter().filter(|c| c.terms.cap.is_none()).map(|c| c.token_id.clone()).collect(),
            rofr_secs: U64(self.rofr_secs),
            owed: self.owed.iter().map(|(a, b)| (a.clone(), U128(*b))).collect(),
        }
    }

    pub fn rounds(&self) -> Vec<Round> {
        self.rounds.clone()
    }

    pub fn offers(&self) -> Vec<Offer> {
        self.offers.clone()
    }

    pub fn priced_rounds(&self) -> Vec<PricedRecord> {
        self.priced.clone()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.storage_of(&account_id))
    }

    /// The exact result of a priced round on today's cap table, and the hash the board's proposal must carry.
    pub fn preview_priced_round(&self, terms: PricedTerms) -> Preview {
        self.preview(&terms)
    }

    /// Who gets what if the company is sold for `exit` micro-dollars today.
    pub fn waterfall(&self, exit: U128) -> WaterfallView {
        let mut claims = vec![];
        let mut labels: Vec<(String, String)> = vec![];
        for c in &self.certs {
            claims.push(Claim::Safe { purchase: c.purchase.0, cap: c.terms.cap.map(|x| x.0) });
            labels.push((c.owner.to_string(), format!("SAFE #{}", c.token_id)));
        }
        let mut common_positions = vec![];
        for p in &self.positions {
            if self.classes[p.class as usize].preferred {
                claims.push(Claim::Preferred { shares: p.shares.0, preference: p.preference.0 });
                labels.push((p.holder.to_string(), self.classes[p.class as usize].name.clone()));
            } else {
                common_positions.push(p);
            }
        }
        let common: u128 = common_positions.iter().map(|p| p.shares.0).sum::<u128>() + self.options;
        let w = ok(math::waterfall(exit.0, common, &claims));
        let mut lines: Vec<Payout> = labels
            .into_iter()
            .zip(w.claims.iter())
            .map(|((holder, label), c)| Payout { holder, label, converts: c.converts, shares: U128(c.shares), payout: U128(c.payout) })
            .collect();
        for p in common_positions {
            lines.push(Payout { holder: p.holder.to_string(), label: "Common".into(), converts: true, shares: p.shares, payout: U128(ok(math_mul_div(w.common_payout, p.shares.0, common.max(1)))) });
        }
        if self.options > 0 {
            lines.push(Payout { holder: "options".into(), label: "Options (as exercised)".into(), converts: true, shares: U128(self.options), payout: U128(ok(math_mul_div(w.common_payout, self.options, common.max(1)))) });
        }
        WaterfallView { exit, lines, detail: w }
    }

    /// Stateless: the conversion math on any inputs (the property tests run thousands of these against the reference).
    pub fn simulate_conversion(&self, cap: math::Cap, safes: Vec<math::Safe>, terms: math::Priced) -> math::Conversion {
        ok(math::convert(&cap, &safes, &terms))
    }

    /// Stateless: the waterfall on any inputs.
    pub fn simulate_waterfall(&self, exit: U128, common: U128, claims: Vec<Claim>) -> math::Waterfall {
        ok(math::waterfall(exit.0, common.0, &claims))
    }

    // NEP-171 / 177 / 181 views

    pub fn nft_metadata(&self) -> NftMetadata {
        NftMetadata { spec: "nft-1.0.0".into(), name: format!("{} SAFE certificates", self.company), symbol: "SAFE".into(), icon: None, base_uri: None, reference: None, reference_hash: None }
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<JsonToken> {
        self.certs.iter().find(|c| c.token_id == token_id).map(|c| self.token_json(c))
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.certs.len() as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let from = from_index.map_or(0, |x| x.0 as usize);
        self.certs.iter().filter(|c| c.owner == account_id).skip(from).take(limit.unwrap_or(50) as usize).map(|c| self.token_json(c)).collect()
    }
}
