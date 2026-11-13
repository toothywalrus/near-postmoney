// Reads Acme's cap table from NEAR testnet over JSON-RPC (views only: free, no wallet). If no RPC answers, the page
// falls back to web/public/snapshot.json and says so.
export const COMPANY = "acme.near-postmoney-8624.testnet";
export const BOARD = "acme-board-8624.sputnik-v2.testnet";
export const USDC = "usdc.near-postmoney-8624.testnet";
export const EXPLORER = "https://testnet.nearblocks.io";
const RPCS = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
let rpcIndex = 0;

function b64(s: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** The contract refused, in its own words. */
export class ViewError extends Error {}

export async function view<T = any>(contract: string, method: string, args: unknown = {}, timeoutMs = 8000): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[(rpcIndex + attempt) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)) } }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const err = j.error ? JSON.stringify(j.error) : j.result?.error;
      if (err) {
        const m = String(err).match(/Smart contract panicked: ([^"\\]+)/)?.[1];
        if (m) throw new ViewError(m);
        throw new Error(String(err).slice(0, 200));
      }
      rpcIndex = (rpcIndex + attempt) % RPCS.length;
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) {
      if (e instanceof ViewError) throw e;
      last = e;
    }
  }
  throw last;
}

export async function finalBlock(): Promise<number> {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(6000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }) });
      const j = await r.json();
      return j.result.header.height;
    } catch {
      /* the next one */
    }
  }
  throw new Error("no RPC answered");
}

export const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;
export const accountUrl = (a: string) => `${EXPLORER}/address/${a}`;
