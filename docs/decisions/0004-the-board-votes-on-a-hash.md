# 0004: The board votes on a preview's hash; execution recomputes and refuses any other

## Context

A board approves a priced round by voting on numbers. Between the vote and the execution the cap table can move (a
SAFE closes, changes hands, an MFN holder amends, options are granted), and the executed conversion would then
differ from what the board saw. On a DAO the gap is real: a proposal sits for days.

## Decision

`preview_priced_round(terms)` returns the full result and `state_hash = sha256(version | terms | result)`, where
`version` is bumped by every change a conversion reads. The board's proposal calls
`execute_priced_round(terms, expected_hash)`; the contract recomputes the preview and refuses unless the hash is
equal. Executing bumps the version, so the same proposal can't run twice.

## Consequences

- On testnet: the board granted one option after the preview, and the proposal executing the old hash passed its
  vote but the cap table refused it ("the cap table or the terms changed since the preview"); the fresh hash executed
  (links in the README). The attack suite also covers a made-up hash, other terms under the old hash, a SAFE moving
  after the preview, and a replay.
- A proposal must be re-filed whenever anything moves; that is the point.
