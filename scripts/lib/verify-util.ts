export { Checks } from "./near.ts";
import type { Chain } from "./near.ts";

/** Whether any testnet RPC answers (verify exits 3, SKIP, when none does). */
export async function rpcOk(chain: Chain): Promise<boolean> {
  try {
    await chain.view("usdc.near-postmoney-8624.testnet", "ft_total_supply");
    return true;
  } catch {
    return false;
  }
}
