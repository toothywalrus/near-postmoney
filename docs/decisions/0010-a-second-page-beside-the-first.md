# 0010: A redesigned page lives beside the first at `/next/`, and the first stays

## Context

On 2026-11-14 the owner asked for a cleaner page in the style of Keyhole's redesign (near-keyhole decision 0026):
task-first, less prose, light and dark themes. The first page (plain TypeScript, `web/src/`) is the one the README,
`docs/launch.md` and the judge's "Web page builds" check describe.

## Decision

The new page is a React app in `web/next/` (pages Overview, Model, SAFEs, Board), built by
`web/vite.next.config.ts` into `web/dist/next/` after the first build, so `npm run build:web` produces both. Its
`data.ts` reuses the first page's `web/src/chain.ts` and `web/src/format.ts` and the reference model in
`ref/reference.ts`, so both pages read the same live views (or the same snapshot when the RPC fails) and the Model
page previews a round with the same arithmetic the contract is checked against. Theme is stored as
`postmoney:theme`. Hosted at `/postmoney/next/`, with the first page at `/postmoney/`.

## Consequences

- Two front ends. The judge's build check builds both but tests neither page's behaviour; the new one was walked by
  hand in a browser (both themes, phone width).
- A fix in `chain.ts`, `format.ts` or `ref/` reaches both pages.
- Which page is the default is a hosting choice in near-lab's `site/deploy.sh`.
