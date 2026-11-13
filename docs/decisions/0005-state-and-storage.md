# 0005: All state in one record, every byte paid from the caller's storage balance

## Context

A startup's cap table has tens of holders, not millions. Every byte on NEAR locks 10^19 yoctoNEAR, and someone has
to pay for it: the investor who adds an investment, the seller who adds an offer, the board for its rounds.
`ft_on_transfer` carries no NEAR, so an investor can't attach a deposit when investing.

## Decision

- The contract keeps its whole state in one borsh record (no lazy collections). Before a mutation it measures the
  record's size, after it measures again, and charges the growth to the caller's storage balance
  (`storage_deposit`, anyone may top up anyone's, e.g. the board's). An investment also reserves 400 bytes for the
  certificate minted at close. Not enough balance: the call panics, and for an investment the token refunds it.
- Caps keep every call's gas bounded: 40 investors a round, 60 outstanding SAFEs.

## Consequences

- Gas grows with the cap table's size, which is fine at a startup's scale and would not be at a public company's.
- Storage isn't refunded when records shrink (refunds, burns); the balance can be withdrawn only by redeploying with
  a withdraw method (not needed for the demo).
