# 0007: Refunds when a board abandons a round; anyone may pay for an investor

## Context

Two gaps found while writing the mainnet path and re-reading the escrow:

1. A round that met its minimum can be closed only by the board. A board that never closes it would hold the
   investors' money in escrow forever; cancelling is also the board's call.
2. "Invest from any chain" goes through NEAR Intents' 1Click, which delivers USDC to a NEAR account and can call
   `ft_transfer_call` with a message (`customRecipientMsg`, accepted by its quote API, checked with a dry quote). The
   sender the contract sees is then the intents account, not the investor.

## Decision

1. `refund` also opens when an open round has passed its deadline by as long again as it ran (a 30-day round: 30
   more days for the board to close it). No new state: it uses the round's own `opened` and `deadline`.
2. The invest message may name the investor: `{"invest": round, "for": "investor.near"}`. The investment, the refund
   and the SAFE certificate are that account's; that account's storage balance pays for the bytes. Without a storage
   balance the call panics and the token returns the money to whoever sent it.

## Consequences

- Investors' worst case is a refund, never a lock-up (`scripts/attacks.ts`: a round that met its minimum is not
  refundable just past its deadline, and is once the board has sat on it as long again).
- A one-step mainnet path: 1Click delivers USDC from Base, Arbitrum, Ethereum or Solana straight into a round for the
  investor. What 1Click does with an amount the round hands back (over its maximum) is up to 1Click's refund flow, so
  a payer should send no more than the room left. Not executed with real money (that is the owner's step).
- Anyone can gift a SAFE to anyone by paying for it; nothing is taken from the beneficiary but their storage balance.
