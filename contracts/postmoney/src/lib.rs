//! Postmoney: a company's cap table, owned by its board (a Sputnik DAO), with the instruments to raise money.
//!
//! - **Common stock and the option pool**: founders' shares, issued options, the unissued pool.
//! - **SAFE rounds**: the board opens a post-money SAFE round (cap, discount, MFN, pro rata, min and max raise,
//!   deadline). Investors pay USDC with `ft_transfer_call`; the money waits here in escrow. Anything over the max is
//!   handed back in the same call. When the board closes the round the money goes to the company's treasury and each
//!   investor gets a NEP-171 SAFE certificate. If the minimum isn't met by the deadline, anyone can refund anyone
//!   (the money only ever goes back to the investor who paid it).
//! - **The priced round**: `preview_priced_round` computes every SAFE's conversion exactly (crate `safe-math`), with a
//!   hash of the cap table and the result; `execute_priced_round` takes that hash and refuses if anything moved since,
//!   so the board votes on numbers it has seen. Executing burns the certificates and records the preferred stock.
//! - **The exit waterfall**, as a view, and **secondary sales with a right of first refusal** for the company.
//!
//! Every money exit has a callback: a failed transfer is rolled back (the escrow, the round, the shares are as they
//! were) or, for the two legs of a right-of-first-refusal match, left claimable with `withdraw_owed`.
//! Every byte a caller adds is paid from that caller's storage balance (`storage_deposit`); the board's actions are
//! paid from the board's balance, which anyone may top up.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use safe_math::{self as math, Basis, Claim, Pool};

mod views;
pub use views::*;

pub type TokenId = String;
const GAS_FT: Gas = Gas::from_tgas(15);
const GAS_CB: Gas = Gas::from_tgas(20);
const GAS_CLOSE_CB: Gas = Gas::from_tgas(60);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Bytes reserved, at investing time, for the certificate the investor will get at close.
const CERT_BYTES: u64 = 400;
/// Bytes reserved, at offer time, for the buyer's new position.
const POSITION_BYTES: u64 = 200;
const MIN_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(5);
pub const MAX_INVESTORS_PER_ROUND: usize = 40;
pub const MAX_OUTSTANDING_SAFES: usize = 60;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub enum RoundStatus {
    Open,
    Closing,
    Closed,
    Refunding,
}

/// A SAFE's terms (an MFN holder may later adopt a later round's).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SafeTerms {
    /// Post-money valuation cap, micro-dollars.
    pub cap: Option<U128>,
    /// Discount in basis points (2000 = 20% off the round's price).
    pub discount_bps: u32,
    /// Most-favored-nation: the holder may adopt the terms of any SAFE round opened later.
    pub mfn: bool,
    /// A pro rata side letter: the right to buy its share of the next priced round.
    pub pro_rata: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RoundTerms {
    pub name: String,
    pub safe: SafeTerms,
    pub min_raise: U128,
    pub max_raise: U128,
    /// Unix seconds.
    pub deadline: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Investment {
    pub investor: AccountId,
    pub amount: U128,
    pub refunded: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Round {
    pub id: u32,
    pub terms: RoundTerms,
    pub token: AccountId,
    pub opened: U64,
    pub raised: U128,
    pub status: RoundStatus,
    pub investments: Vec<Investment>,
}

/// A SAFE certificate: a NEP-171 token while the SAFE is outstanding, burned when it converts.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Certificate {
    pub token_id: TokenId,
    pub owner: AccountId,
    pub round: u32,
    pub purchase: U128,
    pub terms: SafeTerms,
    pub issued: U64,
    /// Set when an MFN holder adopted a later round's terms.
    pub amended_from_round: Option<u32>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Class {
    pub name: String,
    pub preferred: bool,
    /// Original issue price per share, micro-dollars (0 for founders' common).
    pub price: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Position {
    pub holder: AccountId,
    pub class: u32,
    pub shares: U128,
    /// The 1x liquidation preference this position carries, micro-dollars (0 for common).
    pub preference: U128,
    /// Shares under an open secondary offer.
    pub locked: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub enum OfferStatus {
    AwaitingBuyer,
    Funded,
    Settling,
    Settled,
    Matched,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Offer {
    pub id: u32,
    pub seller: AccountId,
    pub buyer: AccountId,
    pub class: u32,
    pub shares: U128,
    /// Total price, micro-dollars.
    pub price: U128,
    pub status: OfferStatus,
    /// The board's right-of-first-refusal window ends at this unix second (set when the buyer pays).
    pub window_ends: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PricedRecord {
    pub name: String,
    pub executed: U64,
    pub price: U128,
    pub state_hash: String,
    /// The full preview the board approved, as JSON.
    pub preview: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Postmoney {
    owner: AccountId,
    company: String,
    usdc: AccountId,
    treasury: AccountId,
    classes: Vec<Class>,
    positions: Vec<Position>,
    /// Issued and outstanding options plus promised options.
    options: u128,
    /// The unissued option pool.
    pool: u128,
    rounds: Vec<Round>,
    certs: Vec<Certificate>,
    next_cert: u64,
    /// Board consents to move one SAFE certificate to one account.
    consents: Vec<(TokenId, AccountId)>,
    offers: Vec<Offer>,
    rofr_secs: u64,
    priced: Vec<PricedRecord>,
    storage: Vec<(AccountId, u128)>,
    owed: Vec<(AccountId, u128)>,
    /// Bumped by every change to what a conversion reads.
    version: u64,
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// Minimal JSON writing for events and cross-contract args (serde_json::Value would add its float formatting to the
/// wasm: every 100 KB of code locks 1 NEAR).
pub(crate) trait J {
    fn j(&self) -> String;
}
impl J for u32 {
    fn j(&self) -> String {
        self.to_string()
    }
}
impl J for u64 {
    fn j(&self) -> String {
        self.to_string()
    }
}
impl J for bool {
    fn j(&self) -> String {
        self.to_string()
    }
}
impl J for U128 {
    fn j(&self) -> String {
        format!("\"{}\"", self.0)
    }
}
impl J for U64 {
    fn j(&self) -> String {
        format!("\"{}\"", self.0)
    }
}
impl J for AccountId {
    fn j(&self) -> String {
        format!("\"{self}\"")
    }
}
impl J for String {
    fn j(&self) -> String {
        self.as_str().j()
    }
}
impl J for &str {
    fn j(&self) -> String {
        let mut o = String::with_capacity(self.len() + 2);
        o.push('"');
        for ch in self.chars() {
            match ch {
                '"' => o.push_str("\\\""),
                '\\' => o.push_str("\\\\"),
                c if (c as u32) < 0x20 => o.push(' '),
                c => o.push(c),
            }
        }
        o.push('"');
        o
    }
}
impl<T: J> J for Option<T> {
    fn j(&self) -> String {
        self.as_ref().map_or("null".into(), |v| v.j())
    }
}
impl<T: J> J for Vec<T> {
    fn j(&self) -> String {
        format!("[{}]", self.iter().map(|v| v.j()).collect::<Vec<_>>().join(","))
    }
}
/// A raw JSON fragment.
pub(crate) struct Raw(pub String);
impl J for Raw {
    fn j(&self) -> String {
        self.0.clone()
    }
}

#[macro_export]
macro_rules! obj {
    ($($k:literal : $v:expr),* $(,)?) => {{
        let mut s = String::from("{");
        $( if s.len() > 1 { s.push(','); } s.push('"'); s.push_str($k); s.push_str("\":"); s.push_str(&$crate::J::j(&$v)); )*
        s.push('}');
        s
    }};
}

fn event(standard: &str, version: &str, name: &str, data: String) {
    env::log_str(&format!("EVENT_JSON:{{\"standard\":\"{standard}\",\"version\":\"{version}\",\"event\":\"{name}\",\"data\":[{data}]}}"));
}

fn ev(name: &str, data: String) {
    event("postmoney", "1.0.0", name, data);
}

fn ft_transfer(token: &AccountId, to: &AccountId, amount: u128, memo: &str) -> Promise {
    Promise::new(token.clone()).function_call(
        "ft_transfer",
        obj!("receiver_id": to.clone(), "amount": U128(amount), "memo": memo).into_bytes(),
        ONE_YOCTO,
        GAS_FT,
    )
}

fn transfer_ok() -> bool {
    env::promise_result_checked(0, 64).is_ok()
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str("overflow"))
}

fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str("underflow"))
}

fn ok<T>(r: Result<T, &'static str>) -> T {
    r.unwrap_or_else(|e| env::panic_str(e))
}

#[near(serializers = [json])]
pub struct Founder {
    pub account: AccountId,
    pub shares: U128,
}

#[near(serializers = [json])]
#[derive(Default)]
struct Msg {
    invest: Option<u32>,
    /// With `invest`: whose SAFE it is, when someone else pays (NEAR Intents' 1Click delivering from another chain).
    #[serde(rename = "for")]
    beneficiary: Option<AccountId>,
    buy: Option<u32>,
    rofr: Option<u32>,
}

#[near]
impl Postmoney {
    /// Founders' common stock, issued and promised options, and the unissued pool. `owner_id` is the board.
    #[init]
    pub fn new(owner_id: AccountId, company: String, usdc: AccountId, treasury: AccountId, founders: Vec<Founder>, options: U128, pool: U128, rofr_secs: Option<U64>) -> Self {
        require!(!founders.is_empty(), "a company needs at least one founder");
        let mut c = Self {
            owner: owner_id,
            company,
            usdc,
            treasury,
            classes: vec![Class { name: "Common".into(), preferred: false, price: U128(0) }],
            positions: vec![],
            options: options.0,
            pool: pool.0,
            rounds: vec![],
            certs: vec![],
            next_cert: 1,
            consents: vec![],
            offers: vec![],
            rofr_secs: rofr_secs.map_or(7 * 24 * 3600, |s| s.0),
            priced: vec![],
            storage: vec![],
            owed: vec![],
            version: 0,
        };
        for f in founders {
            require!(f.shares.0 > 0, "a founder needs shares");
            c.credit_shares(&f.account, 0, f.shares.0, 0);
        }
        c
    }

    // ---------- storage, paid by whoever adds it ----------

    /// Add NEAR to `account_id`'s storage balance (yours by default). The board's balance pays for its actions.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let d = env::attached_deposit();
        require!(d >= MIN_STORAGE_DEPOSIT, "attach at least 0.005 NEAR");
        let b = add(self.storage_of(&who), d.as_yoctonear());
        self.set_storage(&who, b);
        U128(b)
    }


    // ---------- the board ----------

    /// Grant options from the unissued pool (aggregate; individual grants live off-chain in this version).
    pub fn grant_options(&mut self, count: U128) {
        self.board();
        require!(count.0 > 0 && count.0 <= self.pool, "not enough unissued options in the pool");
        self.pool -= count.0;
        self.options = add(self.options, count.0);
        self.version += 1;
        ev("options_granted", obj!("count": count, "pool_left": U128(self.pool)));
    }

    /// Open a post-money SAFE round in the company's token.
    pub fn open_round(&mut self, terms: RoundTerms) -> u32 {
        self.board();
        let before = self.size();
        require!(!terms.name.is_empty() && terms.name.len() <= 64, "name the round (64 characters at most)");
        require!(terms.min_raise.0 > 0 && terms.min_raise.0 <= terms.max_raise.0, "need 0 < min raise <= max raise");
        require!(terms.deadline.0 > now_secs(), "the deadline must be in the future");
        require!(terms.safe.discount_bps < 10_000, "the discount must be under 100%");
        if let Some(cap) = terms.safe.cap {
            require!(cap.0 > terms.max_raise.0, "the cap must be above the max raise");
        }
        let id = self.rounds.len() as u32;
        self.rounds.push(Round { id, terms: terms.clone(), token: self.usdc.clone(), opened: U64(now_secs()), raised: U128(0), status: RoundStatus::Open, investments: vec![] });
        let owner = self.owner.clone();
        self.charge(&owner, before, 0);
        ev("round_opened", obj!("round": id));
        id
    }

    /// Close a round that met its minimum: the money goes to the treasury, and each investor gets a SAFE certificate.
    pub fn close_round(&mut self, round: u32) -> Promise {
        self.board();
        let r = self.round_mut(round);
        require!(r.status == RoundStatus::Open, "the round is not open");
        require!(r.raised.0 >= r.terms.min_raise.0, "the round has not met its minimum");
        r.status = RoundStatus::Closing;
        let (token, raised) = (r.token.clone(), r.raised.0);
        ft_transfer(&token, &self.treasury, raised, "SAFE round proceeds").then(Self::ext(env::current_account_id()).with_static_gas(GAS_CLOSE_CB).on_closed(round))
    }

    #[private]
    pub fn on_closed(&mut self, #[serializer(borsh)] round: u32) -> bool {
        if !transfer_ok() {
            // Roll back: the money is still here, the round is open again, the board may retry.
            self.round_mut(round).status = RoundStatus::Open;
            ev("round_close_failed", obj!("round": round));
            return false;
        }
        let r = self.round_mut(round);
        r.status = RoundStatus::Closed;
        let (name, terms, invs) = (r.terms.name.clone(), r.terms.safe.clone(), r.investments.clone());
        let mut minted = vec![];
        for inv in invs.into_iter().filter(|i| !i.refunded) {
            let token_id = format!("{}", self.next_cert);
            self.next_cert += 1;
            self.certs.push(Certificate { token_id: token_id.clone(), owner: inv.investor.clone(), round, purchase: inv.amount, terms: terms.clone(), issued: U64(now_secs()), amended_from_round: None });
            event("nep171", "1.2.0", "nft_mint", obj!("owner_id": inv.investor.clone(), "token_ids": vec![token_id.clone()], "memo": format!("SAFE, {name}")));
            minted.push(token_id);
        }
        self.version += 1;
        ev("round_closed", obj!("round": round, "certificates": minted));
        true
    }

    /// The board ends an open round early; everyone can then be refunded.
    pub fn cancel_round(&mut self, round: u32) {
        self.board();
        let r = self.round_mut(round);
        require!(r.status == RoundStatus::Open, "the round is not open");
        r.status = RoundStatus::Refunding;
        ev("round_cancelled", obj!("round": round));
    }

    /// Consent to one SAFE certificate moving to one account (SAFEs move only with the company's consent).
    pub fn consent_safe_transfer(&mut self, token_id: TokenId, receiver_id: AccountId) {
        self.board();
        let before = self.size();
        require!(self.certs.iter().any(|c| c.token_id == token_id), "no such outstanding SAFE");
        self.consents.retain(|(t, _)| *t != token_id);
        self.consents.push((token_id, receiver_id));
        let owner = self.owner.clone();
        self.charge(&owner, before, 0);
    }

    // ---------- investing and refunds ----------

    /// NEP-141 receiver. `msg` is `{"invest": round}`, `{"buy": offer}` (a secondary buyer's escrow) or
    /// `{"rofr": offer}` (the treasury matching an offer). Returns what it didn't keep; the token refunds that.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        require!(token == self.usdc, "unknown token: this company only takes its USDC");
        let m: Msg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"invest\": round}, {\"buy\": offer} or {\"rofr\": offer}"));
        match (m.invest, m.buy, m.rofr) {
            (Some(r), None, None) => self.invest(m.beneficiary.unwrap_or(sender_id), amount.0, r),
            (None, Some(o), None) => self.fund_offer(sender_id, amount.0, o),
            (None, None, Some(o)) => self.match_offer(sender_id, amount.0, o),
            _ => env::panic_str("msg must name exactly one of invest, buy, rofr"),
        }
    }

    fn invest(&mut self, investor: AccountId, amount: u128, round: u32) -> U128 {
        let before = self.size();
        let r = self.round_mut(round);
        require!(r.status == RoundStatus::Open, "the round is not open");
        require!(now_secs() < r.terms.deadline.0, "the round's deadline has passed");
        let room = sub(r.terms.max_raise.0, r.raised.0);
        require!(room > 0, "the round is full");
        let take = amount.min(room);
        let existing = r.investments.iter().position(|i| i.investor == investor && !i.refunded);
        match existing {
            Some(i) => r.investments[i].amount = U128(add(r.investments[i].amount.0, take)),
            None => {
                require!(r.investments.len() < MAX_INVESTORS_PER_ROUND, "the round has as many investors as it can take");
                r.investments.push(Investment { investor: investor.clone(), amount: U128(take), refunded: false })
            }
        }
        if existing.is_none() {
            // Certificates to come (open rounds' investors) plus outstanding ones stay under the cap the conversion handles.
            let pending: usize = self.rounds.iter().filter(|r| r.status == RoundStatus::Open || r.status == RoundStatus::Closing).map(|r| r.investments.iter().filter(|i| !i.refunded).count()).sum();
            require!(self.certs.len() + pending <= MAX_OUTSTANDING_SAFES, "the company has as many SAFEs as one conversion handles");
        }
        let r = self.round_mut(round);
        r.raised = U128(add(r.raised.0, take));
        let total = r.raised;
        // A panic here (not enough storage balance) refunds the whole transfer.
        self.charge(&investor, before, if existing.is_some() { 0 } else { CERT_BYTES });
        ev("invested", obj!("round": round, "investor": investor.clone(), "amount": U128(take), "returned": U128(amount - take), "raised": total));
        U128(amount - take)
    }

    /// Refund one investor of a round that was cancelled, that missed its minimum by its deadline, or that the board
    /// left unclosed for as long again as it ran. Anyone may call it; the money goes only to the investor.
    pub fn refund(&mut self, round: u32, investor: AccountId) -> Promise {
        let r = self.round_mut(round);
        // Refunds open when the round missed its minimum by the deadline, or when the board let it sit unclosed for as
        // long again as it ran: investors' money can't be held hostage by a board that never closes.
        let now = now_secs();
        let (deadline, opened) = (r.terms.deadline.0, r.opened.0);
        let abandoned = now >= deadline.saturating_add(deadline.saturating_sub(opened));
        if r.status == RoundStatus::Open && now >= deadline && (r.raised.0 < r.terms.min_raise.0 || abandoned) {
            r.status = RoundStatus::Refunding;
        }
        require!(r.status == RoundStatus::Refunding, "refunds open only when a round is cancelled, misses its minimum by the deadline, or sits unclosed as long again as it ran");
        let i = r.investments.iter().position(|i| i.investor == investor && !i.refunded).unwrap_or_else(|| env::panic_str("nothing to refund to this investor"));
        r.investments[i].refunded = true;
        let amount = r.investments[i].amount.0;
        r.raised = U128(sub(r.raised.0, amount));
        let token = r.token.clone();
        ev("refund", obj!("round": round, "investor": investor.clone(), "amount": U128(amount)));
        ft_transfer(&token, &investor, amount, "SAFE round refund").then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB).on_refunded(round, investor, U128(amount)))
    }

    #[private]
    pub fn on_refunded(&mut self, #[serializer(borsh)] round: u32, #[serializer(borsh)] investor: AccountId, #[serializer(borsh)] amount: U128) -> bool {
        if transfer_ok() {
            return true;
        }
        // Roll back: the escrow is the investor's again; retry later.
        let r = self.round_mut(round);
        if let Some(inv) = r.investments.iter_mut().find(|i| i.investor == investor && i.refunded && i.amount == amount) {
            inv.refunded = false;
            r.raised = U128(add(r.raised.0, amount.0));
        }
        ev("refund_failed", obj!("round": round, "investor": investor));
        false
    }

    // ---------- SAFE certificates (NEP-171) ----------

    /// Moves a SAFE certificate. SAFEs aren't freely transferable: the board must have consented to this receiver.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        let _ = (approval_id, memo);
        let who = env::predecessor_account_id();
        let i = self.certs.iter().position(|c| c.token_id == token_id).unwrap_or_else(|| env::panic_str("no such outstanding SAFE"));
        require!(self.certs[i].owner == who, "only the holder can move this SAFE");
        let consent = self.consents.iter().position(|(t, r)| *t == token_id && *r == receiver_id);
        require!(consent.is_some(), "a SAFE moves only with the board's consent to this receiver (consent_safe_transfer)");
        self.consents.remove(consent.unwrap());
        self.certs[i].owner = receiver_id.clone();
        self.version += 1;
        event("nep171", "1.2.0", "nft_transfer", obj!("old_owner_id": who.clone(), "new_owner_id": receiver_id.clone(), "token_ids": vec![token_id.clone()]));
    }

    /// NEP-171's transfer-and-call: refused, whatever the arguments. SAFEs move only with `nft_transfer` and the board's consent.
    #[payable]
    pub fn nft_transfer_call(&mut self) {
        env::panic_str("SAFE certificates move only with nft_transfer and the board's consent");
    }

    /// An MFN holder adopts the terms of a SAFE round the company opened after issuing this one.
    pub fn adopt_mfn_terms(&mut self, token_id: TokenId, round: u32) {
        let who = env::predecessor_account_id();
        let later = self.rounds.get(round as usize).cloned().unwrap_or_else(|| env::panic_str("no such round"));
        let c = self.certs.iter_mut().find(|c| c.token_id == token_id).unwrap_or_else(|| env::panic_str("no such outstanding SAFE"));
        require!(c.owner == who, "only the holder can amend this SAFE");
        require!(c.terms.mfn, "this SAFE has no MFN provision");
        // A later round: opened after this SAFE's own (its SAFEs are issued after this one). Not one that was called off.
        require!(later.id > c.round && later.status != RoundStatus::Refunding, "MFN applies to SAFEs the company issued later");
        c.terms = later.terms.safe.clone();
        c.amended_from_round = Some(c.round);
        c.round = later.id;
        self.version += 1;
        ev("mfn_adopted", obj!("token_id": token_id.clone(), "round": round));
    }

    // ---------- the priced round ----------

    /// The board executes the priced round it previewed. `expected_hash` is the preview's `state_hash`; if any SAFE,
    /// share or option moved since, or the terms differ, the hash differs and nothing happens.
    pub fn execute_priced_round(&mut self, terms: PricedTerms, expected_hash: String) -> Preview {
        self.board();
        let before = self.size();
        let p = self.preview(&terms);
        require!(p.state_hash == expected_hash, "the cap table or the terms changed since the preview: preview again and vote on the new hash");
        // Standard preferred for the new money; a Safe Preferred sub-series per SAFE round that converts at its cap
        // (or at a discount), as YC's Series A-1, A-2.
        let std_class = self.classes.len() as u32;
        self.classes.push(Class { name: terms.name.clone(), preferred: true, price: p.price });
        let mut sub_series: Vec<(u32, Basis, u32)> = vec![]; // (round, basis, class)
        for s in &p.safes {
            let class = if s.basis == Basis::Price && s.discount_bps == 0 {
                std_class
            } else if let Some(&(_, _, c)) = sub_series.iter().find(|(r, b, _)| *r == s.round && *b == s.basis) {
                c
            } else {
                let c = self.classes.len() as u32;
                let price = if s.shares.0 > 0 { s.purchase.0 / s.shares.0 } else { 0 };
                self.classes.push(Class { name: format!("{}-{} (Safe Preferred)", terms.name, sub_series.len() + 1), preferred: true, price: U128(price) });
                sub_series.push((s.round, s.basis, c));
                c
            };
            self.credit_shares(&s.owner, class, s.shares.0, s.purchase.0);
            event("nep171", "1.2.0", "nft_burn", obj!("owner_id": s.owner.clone(), "token_ids": vec![s.token_id.clone()], "memo": format!("converted into {} shares", s.shares.0)));
        }
        for inv in &p.investors {
            self.credit_shares(&inv.account, std_class, inv.shares.0, inv.cash.0);
        }
        self.certs.clear();
        self.consents.clear();
        self.pool = add(self.pool, p.conversion.pool_increase);
        self.version += 1;
        let preview_json = serde_json::to_string(&p).unwrap_or_default();
        self.priced.push(PricedRecord { name: terms.name.clone(), executed: U64(now_secs()), price: p.price, state_hash: p.state_hash.clone(), preview: preview_json });
        let owner = self.owner.clone();
        self.charge(&owner, before, 0);
        ev("priced_round", obj!("name": terms.name.clone(), "price": p.price, "state_hash": p.state_hash.clone(), "post_money_shares": U128(p.conversion.post_money_shares)));
        p
    }

    // ---------- secondary sales with the company's right of first refusal ----------

    /// Offer shares of one class to a named buyer at a total price (micro-dollars). The shares are locked until the
    /// offer settles or is cancelled. Once the buyer pays, the company has `rofr_secs` to buy them at that price.
    pub fn offer_shares(&mut self, class: u32, shares: U128, price: U128, buyer: AccountId) -> u32 {
        let seller = env::predecessor_account_id();
        let before = self.size();
        require!(shares.0 > 0 && price.0 > 0, "offer a positive number of shares for a positive price");
        require!(buyer != seller, "the buyer must be someone else");
        let pos = self.position_mut(&seller, class).unwrap_or_else(|| env::panic_str("you hold no shares of this class"));
        require!(sub(pos.shares.0, pos.locked.0) >= shares.0, "you don't have that many unlocked shares");
        pos.locked = U128(add(pos.locked.0, shares.0));
        let id = self.offers.len() as u32;
        self.offers.push(Offer { id, seller: seller.clone(), buyer: buyer.clone(), class, shares, price, status: OfferStatus::AwaitingBuyer, window_ends: U64(0) });
        self.charge(&seller, before, POSITION_BYTES);
        ev("offer", obj!("offer": id, "seller": seller.clone(), "buyer": buyer.clone(), "class": class, "shares": shares, "price": price));
        id
    }

    /// The seller withdraws an offer the buyer hasn't paid for yet.
    pub fn cancel_offer(&mut self, offer: u32) {
        let who = env::predecessor_account_id();
        let o = self.offer(offer);
        require!(o.seller == who, "only the seller can cancel");
        require!(o.status == OfferStatus::AwaitingBuyer, "the buyer has paid: the sale goes ahead unless the company matches it");
        self.offers[offer as usize].status = OfferStatus::Cancelled;
        let pos = self.position_mut(&o.seller, o.class).unwrap();
        pos.locked = U128(sub(pos.locked.0, o.shares.0));
        ev("offer_cancelled", obj!("offer": offer));
    }

    fn fund_offer(&mut self, buyer: AccountId, amount: u128, offer: u32) -> U128 {
        let o = self.offer(offer);
        require!(o.buyer == buyer, "this offer is to someone else");
        require!(o.status == OfferStatus::AwaitingBuyer, "this offer is not waiting for payment");
        require!(amount >= o.price.0, "pay the full price");
        let ends = now_secs() + self.rofr_secs;
        let x = &mut self.offers[offer as usize];
        x.status = OfferStatus::Funded;
        x.window_ends = U64(ends);
        ev("offer_funded", obj!("offer": offer, "rofr_window_ends": U64(ends)));
        U128(amount - o.price.0)
    }

    /// The company exercises its right of first refusal: the treasury pays the seller the same price, takes the
    /// shares, and the buyer's escrow goes back to the buyer.
    fn match_offer(&mut self, payer: AccountId, amount: u128, offer: u32) -> U128 {
        require!(payer == self.treasury || payer == self.owner, "only the company's treasury can exercise its right of first refusal");
        let o = self.offer(offer);
        require!(o.status == OfferStatus::Funded, "the offer is not waiting on the company");
        require!(now_secs() < o.window_ends.0, "the right-of-first-refusal window has closed");
        require!(amount >= o.price.0, "match the full price");
        self.offers[offer as usize].status = OfferStatus::Matched;
        let treasury = self.treasury.clone();
        self.move_shares(&o.seller, &treasury, o.class, o.shares.0, false);
        self.version += 1;
        // Two money legs; either one that fails stays claimable with withdraw_owed.
        self.send(&o.seller, o.price.0, "shares bought back by the company (ROFR)");
        self.send(&o.buyer, o.price.0, "the company exercised its ROFR: your escrow back");
        ev("rofr_exercised", obj!("offer": offer));
        U128(amount - o.price.0)
    }

    /// After the window, anyone settles a paid offer the company didn't match: shares to the buyer, money to the seller.
    pub fn settle_offer(&mut self, offer: u32) -> Promise {
        let o = self.offer(offer);
        require!(o.status == OfferStatus::Funded, "the offer is not paid for, or already settled");
        require!(now_secs() >= o.window_ends.0, "the company's right of first refusal is still open");
        self.offers[offer as usize].status = OfferStatus::Settling;
        // The buyer's shares stay locked until the seller is paid.
        self.move_shares(&o.seller, &o.buyer, o.class, o.shares.0, true);
        self.version += 1;
        ft_transfer(&self.usdc, &o.seller, o.price.0, "secondary sale").then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB).on_settled(offer))
    }

    #[private]
    pub fn on_settled(&mut self, #[serializer(borsh)] offer: u32) -> bool {
        let o = self.offer(offer);
        if transfer_ok() {
            let pos = self.position_mut(&o.buyer, o.class).unwrap();
            pos.locked = U128(sub(pos.locked.0, o.shares.0));
            self.offers[offer as usize].status = OfferStatus::Settled;
            ev("offer_settled", obj!("offer": offer));
            return true;
        }
        // Roll back: the shares go back to the seller, still locked, and the offer is paid and ready to settle again.
        self.move_shares(&o.buyer, &o.seller, o.class, o.shares.0, true);
        self.offers[offer as usize].status = OfferStatus::Funded;
        self.version += 1;
        ev("offer_settle_failed", obj!("offer": offer));
        false
    }

    /// Pay out anything owed to `account` from a right-of-first-refusal leg whose transfer failed. Anyone may call it.
    pub fn withdraw_owed(&mut self, account: AccountId) {
        let i = self.owed.iter().position(|(a, _)| *a == account).unwrap_or_else(|| env::panic_str("nothing owed to this account"));
        let (_, amount) = self.owed.remove(i);
        self.send(&account, amount, "owed");
    }

    #[private]
    pub fn on_sent(&mut self, #[serializer(borsh)] to: AccountId, #[serializer(borsh)] amount: U128) -> bool {
        if transfer_ok() {
            return true;
        }
        match self.owed.iter_mut().find(|(a, _)| *a == to) {
            Some(e) => e.1 = add(e.1, amount.0),
            None => self.owed.push((to.clone(), amount.0)),
        }
        ev("owed", obj!("account": to.clone(), "amount": amount));
        false
    }
}

// ---------- internals ----------
impl Postmoney {
    fn board(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the board (the company's DAO) can do this");
    }

    fn size(&self) -> u64 {
        near_sdk::borsh::object_length(self).unwrap_or(0) as u64
    }

    fn storage_of(&self, who: &AccountId) -> u128 {
        self.storage.iter().find(|(a, _)| a == who).map_or(0, |(_, b)| *b)
    }

    fn set_storage(&mut self, who: &AccountId, b: u128) {
        match self.storage.iter_mut().find(|(a, _)| a == who) {
            Some(e) => e.1 = b,
            None => self.storage.push((who.clone(), b)),
        }
    }

    /// Charge `who` for the bytes the state grew since `before`, plus `extra` reserved bytes.
    fn charge(&mut self, who: &AccountId, before: u64, extra: u64) {
        let grown = self.size().saturating_sub(before) + extra;
        if grown == 0 {
            return;
        }
        let cost = grown as u128 * env::storage_byte_cost().as_yoctonear();
        let have = self.storage_of(who);
        if have < cost {
            env::panic_str(&format!("storage: {who} needs {cost} yoctoNEAR more storage balance (storage_deposit)"));
        }
        self.set_storage(who, have - cost);
    }

    fn round_mut(&mut self, id: u32) -> &mut Round {
        self.rounds.get_mut(id as usize).unwrap_or_else(|| env::panic_str("no such round"))
    }

    fn offer(&self, id: u32) -> Offer {
        self.offers.get(id as usize).cloned().unwrap_or_else(|| env::panic_str("no such offer"))
    }

    fn position_mut(&mut self, holder: &AccountId, class: u32) -> Option<&mut Position> {
        self.positions.iter_mut().find(|p| p.holder == *holder && p.class == class)
    }

    fn credit_shares(&mut self, holder: &AccountId, class: u32, shares: u128, preference: u128) {
        match self.position_mut(holder, class) {
            Some(p) => {
                p.shares = U128(add(p.shares.0, shares));
                p.preference = U128(add(p.preference.0, preference));
            }
            None => self.positions.push(Position { holder: holder.clone(), class, shares: U128(shares), preference: U128(preference), locked: U128(0) }),
        }
    }

    /// Move locked shares (and their share of the preference) from one holder to another. With `keep_locked` they
    /// stay locked at the receiver too: a settlement whose payment is still in flight can then be undone exactly.
    fn move_shares(&mut self, from: &AccountId, to: &AccountId, class: u32, shares: u128, keep_locked: bool) {
        let p = self.position_mut(from, class).unwrap_or_else(|| env::panic_str("no such position"));
        let pref = ok(math_mul_div(p.preference.0, shares, p.shares.0));
        p.shares = U128(sub(p.shares.0, shares));
        p.locked = U128(sub(p.locked.0, shares));
        p.preference = U128(sub(p.preference.0, pref));
        self.positions.retain(|p| p.shares.0 > 0 || p.locked.0 > 0);
        self.credit_shares(to, class, shares, pref);
        if keep_locked {
            let q = self.position_mut(to, class).unwrap();
            q.locked = U128(add(q.locked.0, shares));
        }
    }

    fn send(&mut self, to: &AccountId, amount: u128, memo: &str) {
        let _ = ft_transfer(&self.usdc, to, amount, memo).then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB).on_sent(to.clone(), U128(amount)));
    }

    /// The SAFE inputs the math sees, from the outstanding certificates.
    pub(crate) fn safe_inputs(&self) -> Vec<math::Safe> {
        self.certs.iter().map(|c| math::Safe { purchase: c.purchase.0, cap: c.terms.cap.map(|x| x.0), discount_bps: c.terms.discount_bps }).collect()
    }

    pub(crate) fn cap_input(&self) -> math::Cap {
        math::Cap { outstanding: self.positions.iter().map(|p| p.shares.0).sum(), options: self.options, pool: self.pool }
    }
}

fn math_mul_div(a: u128, b: u128, c: u128) -> Result<u128, &'static str> {
    if c == 0 {
        return Ok(0);
    }
    // a * b / c without overflow for the sizes a cap table has (preference x shares < 2^128 is checked).
    a.checked_mul(b).map(|x| x / c).ok_or("overflow")
}
