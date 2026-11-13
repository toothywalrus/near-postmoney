# Postmoney: a cap table whose SAFEs convert themselves

A startup raises its first money on SAFEs and converts them at its first priced round. That conversion is where
founders' spreadsheets go wrong: the post-money SAFE's "Company Capitalization" counts the SAFEs themselves, the round's
price depends on how many shares the SAFEs become, the option pool is topped up before the new money, and every share
count is a whole number. Lawyers reconcile it by hand before closing, while the money sits in a bank account and the
SAFE is a PDF.

Postmoney puts the cap table on NEAR, owned by the company's board (a Sputnik DAO). Investors pay USDC into escrow,
each SAFE is an NFT, and at the priced round the contract converts every SAFE by the post-money SAFE's own formula,
to the share, once the board has voted on the exact numbers.

**One moment from testnet.** Acme's board previewed its Series A, then granted a single option. Proposal 3, which
executed the old preview, passed its vote, and in the same transaction the cap table refused it: "the cap table or the
terms changed since the preview" ([tx](https://testnet.nearblocks.io/txns/BBqZzkREYxvDbYmG4tDEShp81SpVLnhUhLTuYQwgL8dS)).
Nothing converted. Proposal 4 carried the fresh hash and executed
([tx](https://testnet.nearblocks.io/txns/6LeEyWwje2xMdd3apYSM9rpbCZao912VrG4twYWBHjbp)): the cap table came out equal to
the Series A in YC's Post-Money Safe User Guide on every line (11,764,705; 588,235; 1,176,470; $1.1144; 17,946,424).

> **Status (2026-11-13)**
> - **Testnet:** the cap table, a test USDC (no value) and the board DAO, with every transaction linked
>   [below](#on-testnet). `npm run verify` re-reads it (23 checks).
> - **Local, free:** `npm run judge` (8 checks, under 4 minutes, no keys, no Rust).
> - **Mainnet:** nothing deployed. "Invest from any chain" is a keyless 1Click dry quote (`npm run quote`).
> - **Not locked:** the contracts still have the deployer's key, so a fix can ship; `npm run lock` is the owner's call.
> - **Page:** `web/dist/` reads testnet live, with a labelled snapshot fallback.

Built for NEAR HACKATHON. Tracks: `realworld` (a company could use it tomorrow), `social` (a Sputnik DAO is the
board), `nfts` (the SAFE certificate converts itself).

## Judge it in one command

```sh
git clone https://github.com/toothywalrus/near-postmoney && cd near-postmoney
npm ci && npm run judge        # Node 22; no keys, no wallet, no Rust. First run downloads the NEAR sandbox node.
```

It ends in a pass/fail table. Measured on 2026-11-13 from a fresh clone, on an 8-core Linux laptop shared with other
builds (the suites run side by side):

```
Check                                                                                Result  Time   Detail
res/*.wasm match res/SHA256SUMS                                                      PASS    0s     postmoney.wasm, test_usdc.wasm, sputnikdao2-ZGdM2TFd.wasm
Web page builds (web/dist)                                                           PASS    3s     built: serve web/dist with any static server
Reference: YC's worked examples + invariants on 2,000 random rounds and 2,000 exits  PASS    5s     7 ✓, 0 ✗; invariants hold on 1883 converted random cases (713 capped SAFEs took …
Testnet deployment re-read from chain state                                          PASS    7s     23/23 chain checks passed
Kill test on the wasm: contract vs reference, every number (sandbox)                 PASS    113s   wasm = reference on 2500 random priced rounds: 2349 converted identically (6869 SAFEs, 893 capped ones at the round's price), 151 refused by both; 6/6 property checks passed
The company's whole life, board = real Sputnik DAO (sandbox)                         PASS    161s   44/44 sandbox checks passed
Mutation checks: 3 of 21 (npm run mutants runs all)                                  PASS    168s   3/3 mutants caught
Attack suite: each attack meets its stated refusal (sandbox)                         PASS    222s   60/60 attacks refused as expected

All 8 checks passed in 222 s.
```

[`JUDGES.md`](JUDGES.md) maps every claim to its code, its test and its command.

## What it does

- **SAFE rounds.** The board opens a round: post-money valuation cap, discount, MFN, pro rata, minimum and maximum,
  deadline. Investors `ft_transfer_call` USDC with `{"invest": round}`. The money waits in the contract; anything over
  the maximum comes back in the same transaction. A first ticket is at least the round's minimum over its 40 investor
  places, so one-unit investments can't fill a round and shut investors out (decision 0009). Closing sends the money
  to the treasury and mints each investor a NEP-171 SAFE certificate (terms in its metadata, an SVG certificate drawn
  by the contract). A round that misses its minimum by the deadline, or that the board cancels, refunds: anyone may
  trigger anyone's refund, and the money only goes to the investor it belongs to; a funded round the board leaves
  unclosed for as long again as it ran becomes refundable too, so the worst case is a refund, never a lock-up. Someone
  else may pay for an investor (`{"invest": round, "for": "investor.near"}`, how 1Click delivers from another chain;
  decision 0007). Every payout has a callback that rolls back a failed transfer.
- **MFN.** An MFN holder can adopt the terms of any SAFE round the company opened and closed later (YC's clause:
  securities the company *issues* later; `adopt_mfn_terms`); the certificate's terms change.
- **The priced round.** `preview_priced_round` returns the exact result (price per share, each SAFE's shares and
  basis, the pool increase, every new investor's shares) and a hash of the cap table and the result. The board's
  proposal calls `execute_priced_round(terms, hash)`; the contract recomputes and refuses any other hash. Executing
  burns the certificates and records the Series and its Safe Preferred sub-series (YC's "Series A-1, A-2").
- **The waterfall.** `waterfall(exit)`: 1x non-participating preferred and outstanding SAFEs each take their
  preference or convert, whichever pays more.
- **Secondary sales with a right of first refusal.** A holder offers shares to a named buyer, the buyer escrows the
  price, and the company has a window to buy them itself at that price from its treasury. Only after the window does
  the trade settle (shares and money atomically, rolled back if the payment fails).

## The hard question: is the conversion exactly right?

**Yes, to the share, and it's proven against published examples and an independent implementation.**

- **YC's worked examples.** The [Post-Money Safe User Guide](https://www.ycombinator.com/documents) (Appendix II,
  Example 1) gives every line of a company's cap table before and after a Series A ($5m at $15m pre) and a Series Seed
  below one SAFE's cap ($2.2m at $8.8m pre), and what happens in a $10m and a $3m sale. The contract's wasm reproduces
  all four questions to the share: Company Capitalization 11,764,705; SAFEs 588,235 and 1,176,470; price $1.1144;
  4,486,719 Series A shares split 3,589,375 / 448,671 / 448,673; 17,946,424 fully diluted. In the seed round, Investor
  B converts at the round's price (1,216,360 shares, more than at its cap) and Investor A's Company Capitalization
  becomes 11,806,694, giving 590,334 shares: YC's numbers. (`fixtures/yc-examples.json`, `npm run property`.)
- **An independent reference.** `ref/reference.ts` solves the same definitions another way: BigInt fractions, a 2x2
  linear system per assignment of SAFEs to "cap" or "price", and brute force over every assignment (the contract uses
  a threshold scan and a closed form). On **2,500 random priced rounds** (up to 6 SAFEs, caps, discounts, uncapped and
  MFN SAFEs, pool targets and fixed increases, 0 to 6 price decimals) and **2,500 random exits**, the contract's wasm
  and the reference agree on every number (`npm run property`, 26 s). The comparison found one bug, in the reference.
- **It fits in a block.** The first version could not convert what the contract let a company hold: with caps
  that share no factor, 20 SAFEs ran out of NEAR's 300 TGas. Exact arithmetic over common denominators in linear
  scans fixed it without changing a single result: the board's execution converting 60 SAFEs from 8 rounds now burns
  38.5 TGas (`npm run scale`, [decision 0008](docs/decisions/0008-linear-arithmetic-and-a-terms-cap.md)).
- **The rounding rule** is stated in [decision 0002](docs/decisions/0002-conversion-rounding.md): solve exactly, round
  the price once half-up to the round's decimals, round shares down (the Company Capitalization too, as YC does),
  round a pool target up to the least whole number of shares that meets it, and give the last-listed new investor the
  residual share(s) (YC's "other new investors" line). Tested bounds: each capped SAFE within one share of
  purchase / cap of the Company Capitalization; each SAFE got the greater number of shares; the pool meets its target
  and one share less would not; no share created or lost.
- **What didn't work:** a first version iterated the rounded price until `price = round(pre-money / shares it buys)`.
  On 5 of 2,000 random rounds (new money several times the pre-money, a big pool target) no such price exists and it
  never settled. Rounding the exact solution once always has an answer; in 1,810 of 1,883 converted rounds the stated
  pre-money still divides back to the same price.

## Can the board be cheated?

The board votes on a preview; the executed conversion must equal it or fail. The preview's hash covers the cap table's
version, the terms and the full result, and every change a conversion reads bumps the version. On testnet the board
granted one option after previewing the Series A; proposal 3, which executed the old hash, passed its vote and the
cap table refused it in the same transaction
([tx](https://testnet.nearblocks.io/txns/BBqZzkREYxvDbYmG4tDEShp81SpVLnhUhLTuYQwgL8dS): "the cap table or the terms
changed since the preview"). Proposal 4, with the fresh hash, executed. The attack suite adds a made-up hash, other
terms under the old hash, a SAFE that changed hands after the preview, and a replay.

## Money safety

`npm run attacks` runs 60 checks on the real wasm, each attack with the refusal it must meet: invest after close, in
an unknown token, over the max, without storage, after the deadline; double refund; claim another's refund (the money
still goes to who paid); close twice or below the minimum; convert twice; move a SAFE without the board's consent or
to another receiver than consented; front-run the company's right of first refusal; exercise it as a stranger or after
the window; sell the same shares twice; refund a funded round before the board could close it; pay for someone with no
storage balance; take all 40 of a round's places with one-unit investments; two payouts that fail and roll back (to
the treasury at close, to a seller at settlement); and a right-of-first-refusal payment that fails and stays claimable
with `withdraw_owed`. It found a real bug: a failed payout to a secondary seller couldn't roll back, because the
rollback tried to unlock shares the buyer held unlocked; the buyer's shares now stay locked until the seller is paid.


`npm run mutants` builds nothing (the 21 mutants are checked in, `res/mutants/`): it runs the attack suite or the
property test against each deliberately broken contract and expects a failure: no board check, any token, no max, no
least first ticket, free storage, double refund, refund to the caller, refunds before the board could close, MFN
adopting an unissued round's terms, close twice, no hash check, consent for any receiver, no ROFR window, anyone may
exercise ROFR, no rollback at close or at settlement, Company Capitalization rounded up, the pool increase left out of
the pre-money (the classic spreadsheet error), SAFEs left out of their own Company Capitalization (pre-money SAFE
math), capped SAFEs never taking the round's price, and preferred converting the wrong way. Measured: **21/21 caught**
in 457 s (four at a time). Two of them show why the arithmetic is the product: leaving the pool increase out of the
pre-money (the classic spreadsheet error) prices YC's Series A at $1.2750 instead of $1.1144, and leaving the SAFEs
out of their own Company Capitalization (pre-money SAFE math) gives Investor A 500,000 shares instead of 588,235.

## Do X, see Y (from a fresh clone)

| Do | See |
|---|---|
| `npm ci && npm run judge` | the table above, under 4 minutes (plus `npm ci`) |
| `npm run reference` | the reference reproduces YC's four questions; invariants on 2,000 random rounds and exits (5 s, no network) |
| `npm run property` | the contract's wasm reproduces YC's examples and agrees with the reference on 2,500 + 2,500 random cases |
| `npm run sandbox` | the company's whole life with a real Sputnik DAO as the board, YC's numbers on chain (44 checks, ~85 s) |
| `npm run attacks` | 60 checks, each attack refused as stated |
| `npm run mutants` | 21/21 broken contracts caught (about 8 minutes) |
| `npm run verify` | the testnet deployment re-read: code = `res/*.wasm`, the DAO owns it, YC's Series A on chain, the stale proposal refused, the refunds and the rolled-back one (23 checks) |
| `npm run build:web`, then serve `web/dist/` | the page: Acme's cap table live from testnet, the next round modelled by the contract's own preview, the waterfall slider, the SAFE certificates |
| `npm run quote` | keyless 1Click dry quotes: an investor on Base pays USDC, exactly $25,000 USDC lands on NEAR; and 1Click accepts delivering it into a round with the investor named |
| `SEED=9 FRESH=3000 npm run property` | 3,000 more random rounds from another seed |
| `npm run scale` | the contract at its caps: 60 SAFEs from 8 rounds converted by the board in 38.5 TGas, the waterfall on them in 12 TGas, a ninth set of terms refused (~3 minutes) |

## On testnet

Accounts (all made from one faucet draw; [decision 0006](docs/decisions/0006-one-faucet-draw.md)):

| Account | What |
|---|---|
| [`acme.near-postmoney-8624.testnet`](https://testnet.nearblocks.io/address/acme.near-postmoney-8624.testnet) | Acme Robotics' cap table (`res/postmoney.wasm`, 367 KB) |
| [`acme-board-8624.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/acme-board-8624.sputnik-v2.testnet) | the board and treasury: Sputnik DAO, council ada, ben, erin |
| [`usdc.near-postmoney-8624.testnet`](https://testnet.nearblocks.io/address/usdc.near-postmoney-8624.testnet) | tUSDC-TEST, a test token with no value (`res/test_usdc.wasm`, 42 KB) |
| `ada`, `ben` / `erin` / `alice`, `bob` / `carol`, `dave` `.near-postmoney-8624.testnet` | founders and board members / board member / SAFE investors / Series A investors and secondary buyers |

The story (every transaction is in [`deploy/testnet-run.json`](deploy/testnet-run.json)):

| Step | Transaction |
|---|---|
| Proposal 0: open two SAFE rounds ($4m cap; $8m cap with pro rata), approved | [vote](https://testnet.nearblocks.io/txns/Ab2Dz1s18xuqFKiT4i4HUeudq283HvPcy7cb9o9pRyv2) |
| alice pays $250,000 into the $200k round: $200,000 kept, $50,000 back in the same transaction | [tx](https://testnet.nearblocks.io/txns/sBrHvRwMjJV9C57SjhwQDF5MgK8LACnsa1fGbamUu4M) |
| bob pays $800,000 | [tx](https://testnet.nearblocks.io/txns/5XxzddupchbbPAFAkWgTqRLQSn7FhjF8rYPmwviZwEke) |
| Proposal 1: close both rounds: $1m to the DAO, SAFE certificates #1 and #2 minted | [vote](https://testnet.nearblocks.io/txns/6YEpFS9KgofQ1bVgAYBTkY4yb9EMmsUpTDKdBpPge1Sq) |
| Proposal 2: grant one option (the cap table moves after the Series A preview) | [vote](https://testnet.nearblocks.io/txns/nj8YsMchJdhLmdSzA7NaGappdbNXqkb6q4CmB7EZuE9) |
| Proposal 3: execute the Series A with the stale hash: vote passes, **the cap table refuses** | [vote](https://testnet.nearblocks.io/txns/BBqZzkREYxvDbYmG4tDEShp81SpVLnhUhLTuYQwgL8dS) |
| Proposal 4: execute with the fresh hash: SAFEs burned, YC's Series A cap table recorded | [vote](https://testnet.nearblocks.io/txns/6LeEyWwje2xMdd3apYSM9rpbCZao912VrG4twYWBHjbp) |
| ada offers 100,000 common to dave; dave escrows $50,000; settled after the company's window | [escrow](https://testnet.nearblocks.io/txns/BhU77Ut6onmdptj8anBfabGTwjY1xKoqqHBKfQhDaTaJ), [settle](https://testnet.nearblocks.io/txns/8crtyM9yixNyRRAAuTKdyxavwNsUDeiCyqvuqnxYDLTh) |
| ben offers 50,000 to carol; Proposal 5: the treasury buys them at $30,000 (right of first refusal) | [vote](https://testnet.nearblocks.io/txns/8RLnjsp9CURoWctDE1ezWiDMduUcW7J1EbGMrfNhcAYA) |
| Proposals 6-8: an MFN SAFE (bob, $50k), then a bridge round ($30m cap, 20% discount; alice $100k) | [MFN pay](https://testnet.nearblocks.io/txns/Ed3bisAhZkmA7ifpFcApyj5QSj58Z79WLUuDqi24XCtL), [bridge pay](https://testnet.nearblocks.io/txns/3JUicKBynjLCu4GseR3di4fmTqQwKXfJL99HMnHkmeA6) |
| bob's MFN SAFE #3 adopts the bridge round's terms | [tx](https://testnet.nearblocks.io/txns/FzsMas1Yvfzj6cc1gatky1Ln7orvbEhj4jumwcakhanz) |
| Proposal 9: a second bridge round with a $500k minimum and 150 seconds to fill | [vote](https://testnet.nearblocks.io/txns/6VhsariDfbbbAp1eyUhpuNHjrFqJScupLqxajK6LUftu) |
| dave pays $5,000 before adding a storage balance: refused, the token hands it back | [tx](https://testnet.nearblocks.io/txns/AF6n7HmMdfqP9no3EPShJ4Ne9XJZGt1ayVezZF6GoRNj) |
| dave pays $5,000; carol pays $3,000 **for erin** (the investment is erin's) | [dave](https://testnet.nearblocks.io/txns/Ak1W28bpk3UoHu2GdfzsF2ovdPT7UGrZNuwLi4o3RQAY), [carol for erin](https://testnet.nearblocks.io/txns/7keqbgqp23S3ZcdFcm3jzvnkJLKmzUWMYDvo6GiVZrdL) |
| The round misses its minimum; bob (anyone) refunds dave | [tx](https://testnet.nearblocks.io/txns/7MnqCKhLviU8WBVi81YXdDY1rxyPEG45u1VvooWLN4XY) |
| bob refunds erin, who never registered with the token: **the transfer fails and the cap table rolls the refund back** | [tx](https://testnet.nearblocks.io/txns/2svaE7YeFcH2RbnwMhHWp2wM2jf6fCm9Zo5TAvvEB3Yx) |
| erin registers; bob refunds her again; the $3,000 reaches her | [tx](https://testnet.nearblocks.io/txns/AYTifY7VkMahFUYbbzfunEzPB7q35K6NeEXvzEWKTRyK) |

NEAR spent: DAO 4.85, cap table 3.86 (code and state), token 0.45, seven people and gas the rest; 0.57 left on the
funder.

The cap table's code was replaced five times while the deployer's key exists, each time with the state carried over
(same layout): before the story ([tx](https://testnet.nearblocks.io/txns/2GMyrE4v3gVVAT4UsJ9Kv1eswLF8ru2QD6HEoA6kq4A8),
MFN may adopt a later round), then [decision 0007](https://testnet.nearblocks.io/txns/Ft59rq51BKbTN1P8JSYVb43wSivaNdgHioNxtiLbxzfx)
(refunds for abandoned rounds, paying for someone), [decision 0008](https://testnet.nearblocks.io/txns/8vWi5qmH8TRpygXLuVPDB3NmxggPX47KJN9iFhbf2LhP)
(the faster arithmetic), [MFN only from closed rounds](https://testnet.nearblocks.io/txns/FicHXRfXPQCNq6o3TiBUZB5vK6Dpkh4XrRro5Zkfp9a5)
(bob's adoption on chain already met it: round 3 was closed) and [decision 0009](https://testnet.nearblocks.io/txns/7EA4FP6JULsskn21X4nZE7sQYUbwMfAKhL3B2UzEAUmi)
(a least first ticket). `npm run verify` checks that the code running now is `res/postmoney.wasm`.

## What NEAR does here, concretely

- **NEP-141 `ft_transfer_call` is the investment.** The token calls the cap table's `ft_on_transfer`, which escrows
  the money and returns what it didn't keep; the token refunds that in the same transaction. A panic (wrong token,
  closed round, no storage) refunds everything.
- **Promises and callbacks make payouts safe.** Closing a round, refunding, settling a sale: each `ft_transfer` has a
  callback that rolls the state back if the transfer failed; a right-of-first-refusal payment that fails stays owed,
  claimable with `withdraw_owed` (tested by making them fail).
- **NEP-171 tokens are the SAFE certificates**, burned on conversion, with NEP-297 events wallets and explorers read.
- **A Sputnik DAO is the board**: the cap table's `owner` is the DAO account, so every issuance is a FunctionCall
  proposal its council votes on. The same Sputnik bytecode runs in the local sandbox.
- **Storage staking** decides who pays for what: every byte a caller adds is charged to that caller's storage
  balance ([decision 0005](docs/decisions/0005-state-and-storage.md)).
- **NEAR Intents (1Click)** is the mainnet path for investors on other chains: USDC from Base, Arbitrum, Ethereum or
  Solana lands as USDC on NEAR, either in the investor's account or, with `customRecipientMsg`, straight into the
  round for them (priced by `npm run quote`, not executed).

## Prior art

- On NEAR in this hackathon: **Rounds** (a ZK-private cap table approved by a Sputnik DAO) and **Undiluted** (a cap
  table kept in a TEE, changes anchored on NEAR) lead with privacy. Mnemon Payment Agent pays investors when a company
  is sold.
- Elsewhere: MetaLeX's cyberSAFE (EVM; a deal contract escrows USDC and issues a SAFE token), Fairmint and the Open Cap
  Table Format (an SEC-registered transfer agent; a data standard), Carta and Pulley (off-chain cap table software
  with conversion modelling).
- Postmoney's difference: the instruments and their arithmetic are the contract, proven against YC's published
  examples and an independent implementation, with the board voting on a hash of the exact result.

## What was copied from our other repos

- `scripts/lib/keys.ts` and `scripts/faucet.ts`: from `near-proof-of-capture` (keyring, one faucet draw).
- `scripts/lib/near.ts` and `stopSandbox` in `scripts/lib/world.ts`: adapted from `near-till`.
- `res/sputnikdao2-ZGdM2TFd.wasm`: Sputnik DAO v2's bytecode as `sputnik-v2.testnet` deploys it, from `near-circle`
  (`npm run verify` checks it against the live DAO's code hash).
- `scripts/oneclick-quote.ts`: the request shape from near-lab's `spikes/oneclick-quote`.
- The judge table's layout follows `near-proof-of-capture`'s. All MIT, all ours.

## Limits

- **A prototype on testnet, not legal advice or a securities offering.** A SAFE on chain is a record of an agreement;
  the agreement itself (the YC form, signatures, securities law) lives off chain.
- **A SAFE round is open to any NEAR account that pays** (and to anyone a payer names with `"for"`). A real round is
  offered to investors the company chose, often accredited ones; that would need a per-round allowlist and a new
  state layout. Until then the least first ticket (decision 0009) keeps one-unit investments from filling a round.
- **The priced round's new money is recorded, not escrowed** (Series A money usually arrives by wire). SAFE money and
  secondary-sale money do move on chain.
- **Waterfall:** 1x non-participating only; no participation, multiples or seniority between series; options as
  exercised with no strike; uncapped SAFEs take their cash-out amount (YC's MFN form; the discount-only form's
  conversion at a discount to the sale price isn't modelled). [Decision 0003](docs/decisions/0003-waterfall-model.md).
- **Not modelled:** pre-money SAFEs (YC's Example 2), convertible notes, individual option grants and vesting
  (options are an aggregate the board grants from the pool), pro rata purchases as an enforced right (the preview
  reports each holder's pro rata entitlement; the board lists the purchase as new money).
- **Scale:** the whole cap table is one record; 40 investors a round, 60 outstanding SAFEs over at most 8 different
  (cap, discount) pairs. At those caps, with worst-case caps, the board's execution converting 60 SAFEs burns 38.5
  TGas of 300 (`npm run scale`, [decision 0008](docs/decisions/0008-linear-arithmetic-and-a-terms-cap.md)). Fine for
  a startup.
- **Price decimals:** 0 to 6. Rounding rules and their bounds: [decision 0002](docs/decisions/0002-conversion-rounding.md).
- **The contracts aren't locked** until the owner runs `npm run lock`.

## Repository

- `contracts/safe-math`: the conversion and the waterfall (exact integer and rational arithmetic, no near-sdk).
- `contracts/postmoney`: the cap table contract. `contracts/test-usdc`: the test token, without the near-sdk macro.
- `ref/reference.ts`: the independent reference. `fixtures/`: YC's examples and the random cases.
- `scripts/`: the judge, the sandbox suites, testnet deploy/demo/verify, the snapshot, the page shots.
- `web/`: the page (Vite, no framework); `web/dist/` is built. `docs/decisions/`: why things are the way they are.
