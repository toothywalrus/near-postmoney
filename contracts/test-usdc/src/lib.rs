//! TEST TOKEN WITH NO VALUE. A NEP-141 stand-in for USDC (6 decimals) for Postmoney's testnet demo and sandbox:
//! anyone can mint up to 1,000,000 units at a time to themselves. Its name and symbol say it is a test token.
//!
//! Written without near-sdk's `#[near]` macro and without serde: the testnet demo runs on one faucet draw, and
//! every 100 KB of code locks 1 NEAR (the macro and serde_json made this token 138 KB). It reads its JSON
//! arguments with the small parser below and writes JSON by hand. The behaviour is NEP-141's (transfer,
//! transfer-and-call with the refund of what the receiver didn't use) and NEP-145's registration.
//! The sandbox suite (scripts/sandbox.ts) exercises every method.
use near_sdk::{env, AccountId, Gas, NearToken, Promise};

pub const DECIMALS: u8 = 6;
pub const MAX_MINT: u128 = 1_000_000 * 1_000_000;
/// NEP-145: what registering one account costs.
pub const STORAGE: u128 = 1_250_000_000_000_000_000_000;
const GAS_RESOLVE: Gas = Gas::from_tgas(5);
const TOTAL: &[u8] = b"t";

// ---------- a small JSON reader for flat argument objects ----------

#[derive(Debug, PartialEq)]
enum Val {
    Str(String),
    Null,
    Other,
}

fn fail(msg: &str) -> ! {
    env::panic_str(msg)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn peek(&self) -> u8 {
        *self.b.get(self.i).unwrap_or(&0)
    }
    fn eat(&mut self, c: u8) {
        self.ws();
        if self.peek() != c {
            fail("invalid JSON arguments");
        }
        self.i += 1;
    }
    fn string(&mut self) -> String {
        self.eat(b'"');
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.peek();
            self.i += 1;
            match c {
                0 => fail("invalid JSON string"),
                b'"' => break,
                b'\\' => {
                    let e = self.peek();
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let hex = self.b.get(self.i..self.i + 4).unwrap_or_else(|| fail("invalid JSON escape"));
                            let code = u32::from_str_radix(core::str::from_utf8(hex).unwrap_or("x"), 16).unwrap_or_else(|_| fail("invalid JSON escape"));
                            self.i += 4;
                            let ch = char::from_u32(code).unwrap_or('\u{fffd}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => fail("invalid JSON escape"),
                    }
                }
                c => out.push(c),
            }
        }
        String::from_utf8(out).unwrap_or_else(|_| fail("invalid UTF-8"))
    }
    /// Skip any value (objects and arrays with nesting, strings with escapes).
    fn skip(&mut self) {
        self.ws();
        match self.peek() {
            b'"' => {
                self.string();
            }
            b'{' | b'[' => {
                let mut depth = 0i32;
                loop {
                    match self.peek() {
                        0 => fail("invalid JSON"),
                        b'"' => {
                            self.string();
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                self.i += 1;
                                return;
                            }
                        }
                        _ => {}
                    }
                    self.i += 1;
                }
            }
            _ => {
                while self.i < self.b.len() && !matches!(self.b[self.i], b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t') {
                    self.i += 1;
                }
            }
        }
    }
}

/// The top-level fields of a JSON object (an empty input is an empty object).
fn fields(input: &[u8]) -> Vec<(String, Val)> {
    let mut p = P { b: input, i: 0 };
    let mut out = Vec::new();
    p.ws();
    if p.peek() == 0 {
        return out;
    }
    p.eat(b'{');
    p.ws();
    if p.peek() == b'}' {
        return out;
    }
    loop {
        p.ws();
        let k = p.string();
        p.eat(b':');
        p.ws();
        let v = match p.peek() {
            b'"' => Val::Str(p.string()),
            b'n' => {
                p.skip();
                Val::Null
            }
            _ => {
                p.skip();
                Val::Other
            }
        };
        out.push((k, v));
        p.ws();
        match p.peek() {
            b',' => p.i += 1,
            b'}' => break,
            _ => fail("invalid JSON arguments"),
        }
    }
    out
}

struct Args(Vec<(String, Val)>);

impl Args {
    fn read() -> Args {
        Args(fields(&env::input().unwrap_or_default()))
    }
    fn opt_str(&self, k: &str) -> Option<&str> {
        match self.0.iter().find(|(key, _)| key == k).map(|(_, v)| v) {
            Some(Val::Str(s)) => Some(s),
            Some(Val::Null) | None => None,
            Some(Val::Other) => fail(&format!("`{k}` must be a string")),
        }
    }
    fn str(&self, k: &str) -> &str {
        self.opt_str(k).unwrap_or_else(|| fail(&format!("missing `{k}`")))
    }
    fn account(&self, k: &str) -> AccountId {
        self.str(k).parse().unwrap_or_else(|_| fail(&format!("`{k}` is not a valid account id")))
    }
    fn opt_account(&self, k: &str) -> Option<AccountId> {
        self.opt_str(k).map(|s| s.parse().unwrap_or_else(|_| fail(&format!("`{k}` is not a valid account id"))))
    }
    /// A U128 amount, as NEP-141 sends it: a decimal string.
    fn amount(&self, k: &str) -> u128 {
        let s = self.str(k);
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            fail(&format!("`{k}` must be a whole number as a string"));
        }
        s.parse().unwrap_or_else(|_| fail(&format!("`{k}` is out of range")))
    }
}

/// A JSON string literal.
fn q(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn ret(json: &str) {
    env::value_return(json.as_bytes());
}

fn event(name: &str, data: String) {
    env::log_str(&format!("EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"{name}\",\"data\":[{data}]}}"));
}

// ---------- state: balances under "b" + account id, the total supply under "t" ----------

fn key(a: &AccountId) -> Vec<u8> {
    [b"b".as_slice(), a.as_bytes()].concat()
}

fn balance(a: &AccountId) -> Option<u128> {
    env::storage_read(&key(a)).map(|v| u128::from_le_bytes(v.try_into().unwrap_or_else(|_| fail("corrupt balance"))))
}

fn set_balance(a: &AccountId, v: u128) {
    env::storage_write(&key(a), &v.to_le_bytes());
}

fn total() -> u128 {
    env::storage_read(TOTAL).map_or(0, |v| u128::from_le_bytes(v.try_into().unwrap_or_else(|_| fail("corrupt supply"))))
}

fn one_yocto() {
    if env::attached_deposit() != NearToken::from_yoctonear(1) {
        fail("Requires attached deposit of exactly 1 yoctoNEAR");
    }
}

fn refund(to: AccountId, yocto: u128) {
    if yocto > 0 {
        let _ = Promise::new(to).transfer(NearToken::from_yoctonear(yocto));
    }
}

fn storage_balance_json() -> String {
    format!("{{\"total\":\"{STORAGE}\",\"available\":\"0\"}}")
}

fn transfer(from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
    if from == to {
        fail("sender and receiver are the same");
    }
    if amount == 0 {
        fail("amount must be positive");
    }
    let have = balance(from).unwrap_or_else(|| fail("sender is not registered"));
    if have < amount {
        fail("not enough balance");
    }
    let to_have = balance(to).unwrap_or_else(|| fail("receiver is not registered"));
    set_balance(from, have - amount);
    set_balance(to, to_have.checked_add(amount).unwrap_or_else(|| fail("overflow")));
    let memo = memo.map(|m| format!(",\"memo\":{}", q(m))).unwrap_or_default();
    event("ft_transfer", format!("{{\"old_owner_id\":\"{from}\",\"new_owner_id\":\"{to}\",\"amount\":\"{amount}\"{memo}}}"));
}

// ---------- methods ----------

#[no_mangle]
pub extern "C" fn new() {
    // Nothing to set up: balances and the supply live under their own keys. Kept so a deploy can call `new`.
}

/// `mint({"amount": "<micro-units>"})`: up to 1,000,000 test dollars to yourself; attach 0.00125 NEAR to register.
#[no_mangle]
pub extern "C" fn mint() {
    let a = Args::read();
    let amount = a.amount("amount");
    if amount == 0 || amount > MAX_MINT {
        fail("mint 1 unit to 1,000,000 test dollars at a time");
    }
    let who = env::predecessor_account_id();
    let mut left = env::attached_deposit().as_yoctonear();
    let have = match balance(&who) {
        Some(b) => b,
        None => {
            if left < STORAGE {
                fail("attach 0.00125 NEAR to register");
            }
            left -= STORAGE;
            0
        }
    };
    set_balance(&who, have.checked_add(amount).unwrap_or_else(|| fail("overflow")));
    env::storage_write(TOTAL, &total().checked_add(amount).unwrap_or_else(|| fail("overflow")).to_le_bytes());
    event("ft_mint", format!("{{\"owner_id\":\"{who}\",\"amount\":\"{amount}\",\"memo\":\"TEST TOKEN, no value\"}}"));
    refund(who, left);
}

#[no_mangle]
pub extern "C" fn storage_deposit() {
    let a = Args::read();
    let caller = env::predecessor_account_id();
    let who = a.opt_account("account_id").unwrap_or_else(|| caller.clone());
    let deposit = env::attached_deposit().as_yoctonear();
    if balance(&who).is_some() {
        refund(caller, deposit);
    } else {
        if deposit < STORAGE {
            fail("attach at least 0.00125 NEAR");
        }
        set_balance(&who, 0);
        refund(caller, deposit - STORAGE);
    }
    ret(&storage_balance_json());
}

#[no_mangle]
pub extern "C" fn storage_balance_of() {
    let who = Args::read().account("account_id");
    ret(&if balance(&who).is_some() { storage_balance_json() } else { "null".into() });
}

#[no_mangle]
pub extern "C" fn storage_balance_bounds() {
    ret(&format!("{{\"min\":\"{STORAGE}\",\"max\":\"{STORAGE}\"}}"));
}

#[no_mangle]
pub extern "C" fn ft_transfer() {
    one_yocto();
    let a = Args::read();
    transfer(&env::predecessor_account_id(), &a.account("receiver_id"), a.amount("amount"), a.opt_str("memo"));
}

#[no_mangle]
pub extern "C" fn ft_transfer_call() {
    one_yocto();
    if env::prepaid_gas() < Gas::from_tgas(30) {
        fail("attach at least 30 TGas");
    }
    let a = Args::read();
    let (sender, receiver, amount) = (env::predecessor_account_id(), a.account("receiver_id"), a.amount("amount"));
    let msg = a.str("msg").to_string();
    transfer(&sender, &receiver, amount, a.opt_str("memo"));
    let left = env::prepaid_gas().saturating_sub(env::used_gas()).saturating_sub(GAS_RESOLVE).saturating_sub(Gas::from_tgas(5));
    let on = format!("{{\"sender_id\":\"{sender}\",\"amount\":\"{amount}\",\"msg\":{}}}", q(&msg));
    let back = format!("{{\"sender_id\":\"{sender}\",\"receiver_id\":\"{receiver}\",\"amount\":\"{amount}\"}}");
    Promise::new(receiver)
        .function_call("ft_on_transfer", on.into_bytes(), NearToken::from_yoctonear(0), left)
        .then(Promise::new(env::current_account_id()).function_call("ft_resolve_transfer", back.into_bytes(), NearToken::from_yoctonear(0), GAS_RESOLVE))
        .as_return();
}

/// NEP-141: refund what the receiver didn't use (all of it if its ft_on_transfer failed); returns what was used.
#[no_mangle]
pub extern "C" fn ft_resolve_transfer() {
    if env::predecessor_account_id() != env::current_account_id() {
        fail("Method ft_resolve_transfer is private");
    }
    let a = Args::read();
    let (sender, receiver, amount) = (a.account("sender_id"), a.account("receiver_id"), a.amount("amount"));
    let unused = match env::promise_result_checked(0, 64) {
        Ok(v) => {
            // The receiver returns a U128: a quoted decimal string.
            let s = core::str::from_utf8(&v).unwrap_or("").trim().trim_matches('"');
            s.parse::<u128>().map(|u| u.min(amount)).unwrap_or(amount)
        }
        Err(_) => amount,
    };
    let back = if unused > 0 { balance(&receiver).unwrap_or(0).min(unused) } else { 0 };
    if back > 0 {
        set_balance(&receiver, balance(&receiver).unwrap_or(0) - back);
        match balance(&sender) {
            Some(b) => set_balance(&sender, b + back),
            // The sender unregistered meanwhile: burn it, as NEP-141 allows.
            None => {
                env::storage_write(TOTAL, &(total() - back).to_le_bytes());
            }
        }
        event("ft_transfer", format!("{{\"old_owner_id\":\"{receiver}\",\"new_owner_id\":\"{sender}\",\"amount\":\"{back}\",\"memo\":\"refund\"}}"));
    }
    ret(&format!("\"{}\"", amount - back));
}

#[no_mangle]
pub extern "C" fn ft_total_supply() {
    ret(&format!("\"{}\"", total()));
}

#[no_mangle]
pub extern "C" fn ft_balance_of() {
    let who = Args::read().account("account_id");
    ret(&format!("\"{}\"", balance(&who).unwrap_or(0)));
}

#[no_mangle]
pub extern "C" fn ft_metadata() {
    ret(&format!(
        "{{\"spec\":\"ft-1.0.0\",\"name\":\"TEST USDC (no value)\",\"symbol\":\"tUSDC-TEST\",\"icon\":null,\"reference\":null,\"reference_hash\":null,\"decimals\":{DECIMALS}}}"
    ));
}
