# Decision records

Short records of *why* a non-obvious choice was made. The code and its comments say *what* it does.

Each record has **Context** (the problem or constraint), **Decision** (what was decided) and **Consequences**
(what it costs or rules out, with pointers to files). Records are numbered, never renumbered, and never rewritten:
a later decision that supersedes one gets a new record, and the old entry is struck through here.

| # | Decision |
|---|----------|
| [0001](0001-one-contract-per-company-owned-by-its-dao.md) | One contract per company, owned by its Sputnik DAO; SAFEs are NFTs that only move with the board's consent |
| [0002](0002-conversion-rounding.md) | The conversion is solved exactly, then rounded once: price half-up to the round's decimals, shares down, the pool target up |
| [0003](0003-waterfall-model.md) | The waterfall: 1x non-participating preferred and post-money SAFEs, each claimant's choice found by best response |
| [0004](0004-the-board-votes-on-a-hash.md) | The board votes on a preview's hash; execution recomputes and refuses any other |
| [0005](0005-state-and-storage.md) | All state in one record, every byte paid from the caller's storage balance; caps of 40 investors a round and 60 SAFEs |
| [0006](0006-one-faucet-draw.md) | The testnet demo fits one faucet draw: a macro-free test token, gas lent per call, keys kept until `npm run lock` |
| [0007](0007-refunds-if-abandoned-and-paying-for-someone.md) | Refunds open when a board leaves a funded round unclosed as long again as it ran; anyone may pay for an investor (`"for"`) |
