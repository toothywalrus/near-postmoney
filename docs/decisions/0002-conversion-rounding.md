# 0002: The conversion is solved exactly, then rounded once

## Context

A post-money SAFE's "Company Capitalization" includes the SAFEs themselves (a circular definition); the priced
round's price per share depends on how many shares the SAFEs become (a SAFE takes whichever of its cap price and the
round's price, times its discount, gives more shares); and a pool target sized as a share of the post-money depends
on the price. Shares are whole numbers, so something must be rounded, and the rule must be stated, since a
founder's spreadsheet and a lawyer's will otherwise differ by a few shares.

The kill test asked: can the contract's integer math match an independent exact reference to the share, on YC's
published examples and on random cases?

## Decision

1. **Solve exactly** (rational numbers over big integers, `contracts/safe-math`): for the SAFEs sorted by
   cap / Discount Rate, try each threshold of "these convert at the round's price, the rest at their caps", solve the
   circle in closed form, keep the assignment where every SAFE got the greater number of shares (ties go to the cap).
2. **Round the price once**, half-up, to the round's `price_decimals` (YC's examples use $0.0001).
3. **Everything else follows from the rounded price**, rounded down: each SAFE's shares at the price
   (`floor(purchase / (price x Discount Rate))`); the Company Capitalization (`floor`, as YC's guide does); each
   capped SAFE's shares (`floor(Company Capitalization x purchase / cap)`); the new money's total
   (`floor(total cash / price)`), each investor `floor(cash / price)` and the last-listed investor the residual (YC's
   tables put it on "other new investors"). With a pool *target*, the increase is the least whole number of shares
   that makes the unissued pool at least that share of the post-money.
4. **"The greater number of shares" is decided on the whole numbers** at the rounded price.

We do not force `price = round(pre-money / pre-money shares)` to hold exactly after rounding. A first version
iterated the rounded price to that fixed point; on 5 of 2,000 random cases (new money several times the
pre-money with a large pool target) the map's slope is above 1 and no fixed point exists, so it never settled.
Rounding the exact solution once always has an answer. On the 1,883 random rounds that convert, the stated
pre-money divided by the shares it buys rounds back to the same price in 1,810.

## Consequences

- YC's Post-Money Safe User Guide, Appendix II, Example 1, Questions 2 and 5 (both rounds, every line of both cap
  tables) and 3 and 4 (the sale) are reproduced to the share by the contract's wasm (`npm run property`).
- The wasm and the reference (`ref/reference.ts`, which solves a 2x2 linear system per mode assignment and
  brute-forces every assignment) agree on every number of 2,500 random rounds. The reference itself was wrong once
  (it fell back to "no pool increase" on a negative-price solution); the disagreement found it.
- The bounds, tested: each capped SAFE within one share of purchase / cap of the Company Capitalization; the pool at
  least its target and one share less would miss it; no share created or lost (`scripts/reference-check.ts`).
