// NEAR plumbing for the scripts, on a local sandbox or on testnet. Keys live in the OS keyring (scripts/lib/keys.ts)
// or in this process, never in a file. (Adapted from near-till's scripts/lib/near.ts, MIT, our own repo.)
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";

export type Result = { ok: boolean; value?: any; reason?: string; tx?: string; logs: string[]; gas?: number };
export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const milli = (n: number) => BigInt(n) * 10n ** 21n;
export const USD = 1_000_000n;
export const usd = (n: number | bigint) => BigInt(n) * USD;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Chain {
  readonly provider: JsonRpcProvider;
  private fallbacks: JsonRpcProvider[];
  private keys = new Map<string, string>();
  constructor(readonly rpc: string, readonly opts: { explorer?: string; fallbacks?: string[]; keyOf?: (id: string) => string | undefined } = {}) {
    this.provider = new JsonRpcProvider({ url: rpc });
    this.fallbacks = (opts.fallbacks ?? []).map((url) => new JsonRpcProvider({ url }));
  }
  txLink = (h?: string) => (this.opts.explorer && h ? `${this.opts.explorer}/txns/${h}` : h ?? "");
  accountLink = (id: string) => (this.opts.explorer ? `${this.opts.explorer}/address/${id}` : id);
  remember(id: string, key: string) {
    this.keys.set(id, key);
  }
  keyOf(id: string): string | undefined {
    return process.env[`KEY_${id.replace(/[.-]/g, "_")}`] ?? this.keys.get(id) ?? this.opts.keyOf?.(id);
  }
  account(id: string): Account {
    const key = this.keyOf(id);
    if (!key) throw new Error(`no key for ${id}`);
    return new Account(id, this.provider, key as KeyPairString);
  }
  async exists(id: string) {
    try {
      await this.provider.viewAccount({ accountId: id });
      return true;
    } catch {
      return false;
    }
  }
  async balance(id: string): Promise<bigint> {
    return BigInt((await this.provider.viewAccount({ accountId: id })).amount);
  }
  /** A view; public RPCs rate-limit a shared IP, so back off and try the fallbacks. */
  async view<T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    let last: unknown;
    const ps = [this.provider, ...this.fallbacks];
    for (let i = 0; i < 6; i++) {
      const p = ps[i % ps.length];
      try {
        return (await p.callFunction({ contractId, method, args })) as T;
      } catch (e) {
        last = e;
        if (!/429|rate limit|fetch failed|timeout|ETIMEDOUT|ECONN|Too Many/i.test(String((e as Error).message ?? e) + String((e as any).cause ?? ""))) throw e;
        await sleep(500 * (i + 1));
      }
    }
    throw last;
  }
  /** A view that may refuse: `{ok: false, reason}` with the contract's own words. */
  async tryView<T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: T; reason?: string }> {
    try {
      return { ok: true, value: await this.view<T>(contractId, method, args) };
    } catch (e) {
      return { ok: false, reason: panicOf(String((e as Error)?.message ?? e)) };
    }
  }
  async subAccount(parent: Account, name: string, near: string): Promise<Account> {
    const id = `${name}.${parent.accountId}`;
    const key = KeyPair.fromRandom("ed25519");
    this.remember(id, key.toString());
    await parent.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near as `${number}`) });
    return this.account(id);
  }
  /** The chain's own clock, unix seconds. */
  async secs(): Promise<number> {
    const b = (await this.provider.viewBlock({ finality: "final" } as any)) as { header: { timestamp_nanosec: string } };
    return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000_000n);
  }
}

export function panicOf(text: string): string {
  const m = text.match(/(?:Smart contract panicked|panicked at[^:]*): ((?:[^"\\\n]|\\.)+)/)?.[1] ?? text.match(/ExecutionError\W+"?([^"\\]+)/)?.[1];
  return (m ?? text.slice(0, 240)).replace(/\\+"/g, '"').replace(/\\+$/, "");
}

/** Call a contract and wait for FINAL, so cross-contract receipts have landed. A refusal comes back as
 *  `{ok: false, reason}` with the contract's own words. `ok` means no receipt failed. */
export async function call(acct: Account, contractId: string, method: string, args: Record<string, unknown> | Uint8Array, deposit = 0n, tgas = 100n): Promise<Result> {
  try {
    const r: any = await acct.callFunctionRaw({ contractId, methodName: method, args: args as any, deposit, gas: tgas * TGAS, waitUntil: "FINAL" });
    const logs = r.receipts_outcome.flatMap((o: any) => o.outcome.logs);
    const failed = r.receipts_outcome.map((o: any) => o.outcome.status?.Failure).find(Boolean);
    const sv = r.status?.SuccessValue;
    let value: any;
    if (sv) {
      const raw = Buffer.from(sv, "base64").toString();
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    const gas = (r.transaction_outcome.outcome.gas_burnt + r.receipts_outcome.reduce((n: number, o: any) => n + o.outcome.gas_burnt, 0)) / 1e12;
    return { ok: !failed && !r.status?.Failure, value, tx: r.transaction.hash, logs, gas, reason: failed ? panicOf(JSON.stringify(failed)) : r.status?.Failure ? panicOf(JSON.stringify(r.status.Failure)) : undefined };
  } catch (e) {
    const text = String((e as Error)?.message ?? e);
    return { ok: false, reason: panicOf(text), logs: [] };
  }
}

/** Events (NEP-297) in a result's logs. */
export const events = (r: Result, standard?: string) =>
  r.logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11))).filter((e) => !standard || e.standard === standard);

export class Checks {
  fails = 0;
  count = 0;
  constructor(readonly quiet = false) {}
  check(good: boolean, what: string, detail: unknown = "") {
    this.count++;
    if (!good) this.fails++;
    const d = String(detail ?? "");
    if (!this.quiet || !good) console.log(`${good ? "✓" : "✗"} ${what}${d ? `  (${d.length > 160 ? d.slice(0, 160) + "…" : d})` : ""}`);
    return good;
  }
  /** An attack, with the refusal it must meet. */
  refused(r: { ok: boolean; reason?: string; value?: any }, want: string, what: string) {
    return this.check(!r.ok && (r.reason ?? "").includes(want), what, r.ok ? `ACCEPTED: ${JSON.stringify(r.value)?.slice(0, 100)}` : `refused: ${r.reason}`);
  }
  section(s: string) {
    console.log(`\n${s}`);
  }
}
