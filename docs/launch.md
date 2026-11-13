# Launch: a draft post and a 60-second demo script (for the owner; he posts)

## Draft X post

> A startup's SAFEs, on NEAR, that convert themselves.
>
> Postmoney is a cap table whose board is a Sputnik DAO. Investors pay USDC into escrow, get their SAFE as an NFT, and
> at the priced round the contract converts every SAFE by the post-money SAFE's formula.
>
> We ran YC's own worked example on testnet. The chain's cap table matches YC's guide on every line, to the share.
>
> The board votes on a hash of the exact numbers. When the cap table moved after the vote, the contract refused to
> execute it.
>
> [repo link] · [page link]

Shorter alternative (one post):

> YC's Post-Money SAFE guide has a worked Series A. We ran it on NEAR: SAFEs as NFTs, USDC in escrow, a Sputnik DAO
> board voting on a hash of the result. 11,764,705. 588,235. 1,176,470. $1.1144. Same as the guide, to the share.
> Postmoney, for NEAR HACKATHON. [link]

## 60-second demo script

| Time | Screen | Voice |
|---|---|---|
| 0-6 s | The page's hero: "Acme Robotics, Inc.", status "Live from NEAR testnet" | "This is a company's cap table on NEAR. Its board is a Sputnik DAO." |
| 6-14 s | §1 the ownership bar; hover a SAFE segment | "Founders, a Series A, the option pool, and two SAFEs still outstanding: each shown at its cap, as the post-money SAFE promises." |
| 14-26 s | §2: drag the pre-money slider down, then up; the bar redraws; the SAFE rows flip between "at its cap" and "at the round's price × 80%" | "Model the next round. Every number is the contract's own preview: the price, the pool top-up, and each SAFE taking whichever of its cap or its discount gives more shares." |
| 26-34 s | §3 the SVG certificates | "Each SAFE is an NFT minted when the round closed, drawn by the contract. It moves only with the board's consent." |
| 34-44 s | §5 the YC vs chain table, all ticks | "This is YC's worked example from the Post-Money SAFE guide, run on testnet by the DAO. Every line matches, to the share." |
| 44-52 s | §6, proposal 3 in red | "The board votes on a hash of the numbers. When the cap table moved after this vote, the contract refused to execute it." |
| 52-60 s | Terminal: `npm run judge`, the table of PASS | "Twenty-five hundred random rounds against an independent implementation, fifty attacks, eighteen broken builds caught. One command." |

## Before posting

- Make the repo public (owner).
- Host the page (`web/dist/`) where he wants it; it reads testnet directly, no server.
- Optionally `npm run lock -- --yes` so the cap table answers only to its DAO.
