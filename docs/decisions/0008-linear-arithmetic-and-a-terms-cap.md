# 0008: The exact arithmetic runs over common denominators, and outstanding SAFEs may carry at most 8 different terms

## Context

`npm run scale` (written to check the contract's own caps) showed the first version could not convert what the
contract let a company hold. With caps that share no factor (odd numbers of dollars, the worst case for exact
fractions), a priced round over 20 SAFEs ran out of NEAR's 300 TGas, and the waterfall over 10 SAFEs and 10 preferred
holders burned 264 TGas. A board unable to execute its priced round would be stuck: a liveness bug, not a slow view.
The cost was big-integer gcds on every fraction step (`num-bigint`'s binary gcd is slow in wasm) and loops that
recomputed sums from scratch at every threshold.

## Decision

- **Common denominators instead of reduced fractions** in the hot paths (`contracts/safe-math`): the sum of
  purchase/cap is kept as `na / d` with `d` the lcm of the caps, and the sum of purchase/Discount Rate as `nb / e`.
  The exact price is one closed formula in whole numbers per threshold (the formulas are in `exact_price`'s comment).
  Only the final price is reduced, once.
- **Linear scans**: thresholds move whole groups of SAFEs of equal value (cap / Discount Rate) and update the two sums;
  only the groups either side of a threshold are checked. The whole-share step recomputes the Company Capitalization
  only when a SAFE moves to the round's price. The waterfall's best response reuses the current split and computes
  only the alternative.
- **At most 8 different (cap, discount) pairs** among outstanding SAFEs and open rounds (`MAX_DISTINCT_TERMS`), checked
  when a round opens and when an MFN holder adopts terms. Rounds share terms, so this is 8 SAFE rounds' worth.

The semantics are unchanged: same thresholds, same tie rule, same rounding. The 4,000 reference cases and YC's examples
agree as before, and the mutation checks were rebuilt on the new code.

## Consequences

Measured on the sandbox (`npm run scale`, worst-case caps):

| Case | Before | After |
|---|---|---|
| Conversion, 10 SAFEs over 10 caps | 51 TGas | 8.7 TGas |
| Conversion, 20 SAFEs over 20 caps | 216 TGas | 26 TGas |
| Conversion, 60 SAFEs over 8 caps | 296 TGas | 45 TGas |
| Waterfall, 60 SAFEs over 8 caps + 20 preferred | out of gas | 39 TGas |
| `execute_priced_round` converting 60 SAFEs from 8 rounds (end to end) | not measured | 38.5 TGas |

A ninth different set of terms is refused with "the company has as many different SAFE terms outstanding as one
conversion handles"; converting (a priced round) clears them.
