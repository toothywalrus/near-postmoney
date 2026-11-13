# 0003: The waterfall: 1x non-participating preferred and post-money SAFEs, by best response

## Context

"Who gets what if we sell for $X" is a view of the same cap table. Each preferred series and each outstanding SAFE
takes the greater of its preference (for a SAFE, its Cash-Out Amount, the purchase) and its as-converted share of
what's left. Those choices depend on each other: who converts changes the common pool, and for a SAFE the Liquidity
Capitalization it converts against includes only the securities that convert (YC's definition).

## Decision

- `safe_math::waterfall`: preferences are senior and pari passu with each other (pro rata if the exit can't cover
  them); everyone converting shares the rest per share. Each claimant converts exactly when converting pays it
  strictly more given everyone else's choice; the stable choice is found by best response.
- A capped SAFE's Conversion Amount: `floor(Liquidity Capitalization x purchase / cap)` shares, where the Liquidity
  Capitalization is `floor((common + converting preferred) / (1 - sum of purchase/cap over converting SAFEs))`.
  Unissued options are excluded; issued options count as exercised (strike ignored).
- Uncapped SAFEs (discount-only, or MFN not yet amended) take their Cash-Out Amount. YC's MFN form gives only that;
  the discount-only form's conversion at a discount to the sale price is not modelled.
- Payouts round down to the micro-dollar; the dust is reported.

## Consequences

- YC's Example 1, Questions 3 and 4: both SAFEs convert at $10m (561,764 and 1,123,529 shares, Liquidity
  Capitalization 11,235,293) and both cash out at $3m. YC's dollar figures use a per-share price rounded to $0.0001,
  ours are exact.
- The reference brute-forces every set of converters and asserts the equilibrium is unique; on 2,500 random exits it
  is, and the wasm agrees on every choice and payout.
- Limits: no participation, no multiples above 1x, no seniority between series, no strike prices.
