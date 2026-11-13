// The testnet deployment's names (no secrets: keys are in the OS keyring, service near-lab-testnet).
// FUNDER_ID / DAO override them, for a judge's own deployment.
import { keychainLoad } from "./keys.ts";
import { Chain } from "./near.ts";

export const FUNDER = process.env.FUNDER_ID ?? "near-postmoney-8624.testnet";
const suffix = FUNDER.match(/-(\w+)\.testnet$/)?.[1] ?? "x";
export const USDC = process.env.USDC ?? `usdc.${FUNDER}`;
export const COMPANY = process.env.COMPANY ?? `acme.${FUNDER}`;
export const DAO = process.env.DAO ?? `acme-board-${suffix}.sputnik-v2.testnet`;
export const FACTORY = "sputnik-v2.testnet";
export const EXPLORER = "https://testnet.nearblocks.io";
export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const FALLBACKS = ["https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
/** People in the demo: two founders (also on the board), a third board member, two SAFE investors, the Series A lead, another buyer. */
export const PEOPLE = ["ada", "ben", "erin", "alice", "bob", "carol", "dave"] as const;
export const person = (n: (typeof PEOPLE)[number]) => `${n}.${FUNDER}`;

export function testnet(): Chain {
  return new Chain(RPC, {
    explorer: EXPLORER,
    fallbacks: FALLBACKS,
    keyOf: (id) => {
      try {
        return keychainLoad(id);
      } catch {
        return undefined;
      }
    },
  });
}
