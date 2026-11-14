# 0009: A first ticket is at least the round's minimum over its 40 investor places

## Context

Decision 0005 caps a round at 40 investors so that closing it fits in a callback's gas. Any account could take one of
those places with a one-unit investment, and with `"for"` (decision 0007) it didn't even need 40 accounts of its own:
40 made-up account ids, each with a 0.006 NEAR storage balance, filled a round, and an honest $5,000 investor was then
refused with "the round has as many investors as it can take". The board's only remedy was to cancel and reopen, and
the same spend filled the new round. The attack suite proved it on the earlier wasm (`scripts/attacks.ts`, "Investor
places": 40 places taken, the honest investor refused).

## Decision

A new investor's first payment must be at least `ceil(min_raise / 40)`, or all the room left in the round if that is
less. Top-ups by an investor already in the round are not affected. The places can then run out only once the round
has met its minimum: whoever took them has paid the minimum in, and the board can close the round or cancel it.

A per-round minimum chosen by the board would be more flexible. It would need a new field in the round's terms, and so
a new state layout and a migration of the testnet deployment. This rule needs no new state, and the testnet code can be
replaced in place (`npm run deploy`).

## Consequences

- A round with a $1m minimum takes first tickets of $25,000 or more. A board that wants smaller tickets sets a smaller
  minimum. A round with a very small minimum gets little protection from this rule.
- The company-wide cap of 60 outstanding SAFEs can still be used up by investors who really pay. That costs real money,
  and the board can cancel a round rather than close it.
- `scripts/attacks.ts` checks that one-unit first tickets are refused and that an honest investor still gets a place.
  The `no-least-ticket` mutant removes the check, and the attack suite must catch it. Some test tickets were raised to
  meet the floor (attacks rounds 2 and 3, the sandbox's bridge round), and so was the demo's Bridge II for a fresh run.
  The recorded testnet run predates this rule.
