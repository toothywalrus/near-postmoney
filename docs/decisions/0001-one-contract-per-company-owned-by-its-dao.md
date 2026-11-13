# 0001: One contract per company, owned by its Sputnik DAO; SAFEs are NFTs that only move with the board's consent

## Context

A cap table is one company's record of who owns what, and the board decides every change to it except the ones
investors make themselves (paying in, claiming refunds). Illia's idea (Oct 3, item 8) asks for "a company cap table,
with instruments to raise funds and accept crypto". The instruments that matter at a startup's first rounds are the
post-money SAFE and the priced round it converts in.

## Decision

- **One contract account per company** (`contracts/postmoney`). Its `owner` is the board: on testnet a Sputnik DAO
  made by `sputnik-v2.testnet`, so every board action is a FunctionCall proposal its council approves. A plain account
  can be the owner too (the attack suite uses one, for speed).
- **The money is NEP-141**: investors `ft_transfer_call` the company's USDC with `{"invest": round}`. The contract
  holds it in escrow until the board closes the round (then it goes to the treasury, the DAO) or the round is
  cancelled or misses its minimum (then anyone can trigger anyone's refund, and it goes back to who paid).
- **Each SAFE is a NEP-171 token** whose metadata carries its terms and an SVG certificate. It is burned when it
  converts. SAFEs are not freely transferable (YC's SAFE: transfers need the company's consent), so `nft_transfer`
  needs a board consent for that token to that receiver, and `nft_transfer_call` always refuses.
- **Secondary sales go through the company's right of first refusal**: a holder offers shares to a named buyer, the
  buyer escrows the price, and the company has a window to buy them itself at that price from its treasury.

Not a factory that deploys one cap table per company: each company's contract costs ~3.7 NEAR of storage either way,
and a factory adds a contract and a trust step without changing what a judge or a company can verify.

## Consequences

- The board can do nothing the contract doesn't allow: it can't move an investor's escrow, convert at numbers it
  didn't preview (0004), or take a refund for itself.
- The priced round's new money is recorded, not escrowed (Series A money usually arrives by wire); only SAFE money and
  secondary-sale money move on chain.
- See `contracts/postmoney/src/lib.rs` (rounds, escrow, certificates, offers) and `views.rs` (the views).
