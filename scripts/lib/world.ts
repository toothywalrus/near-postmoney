// A whole Postmoney world on a local NEAR sandbox: free, offline after the node's first download, no Rust needed
// (the wasm is checked in under res/). The test USDC, the cap table, and optionally the board as a real Sputnik DAO
// (the same bytecode sputnik-v2.testnet deploys, res/sputnikdao2-ZGdM2TFd.wasm).
// (stopSandbox is adapted from near-till's scripts/lib/sandbox.ts, MIT, our own repo.)
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { actions, type Account } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { call, Chain, milli, NEAR, sleep, TGAS, usd, type Result } from "./near.ts";

// near-sandbox gives a starting node NEAR_RPC_TIMEOUT_SECS (default 10) to answer, then throws and leaves the node
// running. npm run judge starts four nodes at once; on a busy machine that can take longer, so allow 90 s.
process.env.NEAR_RPC_TIMEOUT_SECS ??= "90";

const RES = new URL("../../res/", import.meta.url);
export const wasm = (file: string) => {
  const b = readFileSync(new URL(file, RES));
  return file.endsWith(".gz") ? gunzipSync(b) : b;
};

/** The cap-table wasm under test: res/postmoney.wasm, or POSTMONEY_WASM (a mutant, say; .gz is fine). */
export const postmoneyWasm = () => {
  const f = process.env.POSTMONEY_WASM;
  if (!f) return wasm("postmoney.wasm");
  const b = readFileSync(f);
  return f.endsWith(".gz") ? gunzipSync(b) : b;
};

export type World = Awaited<ReturnType<typeof startWorld>>;

/** Founders 9,250,000 common; options 650,000 (300k issued + 350k promised); pool 100,000: YC's Example 1 company. */
export const FOUNDERS = [
  { name: "ada", shares: 6_000_000n },
  { name: "ben", shares: 3_250_000n },
];

export async function startWorld(opts: { postmoney?: Buffer; board?: "plain" | "dao"; rofrSecs?: number; options?: bigint; pool?: bigint } = {}) {
  const sandbox = await Sandbox.start({});
  const chain = new Chain(sandbox.rpcUrl);
  chain.remember(DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY);
  const root = chain.account(DEFAULT_ACCOUNT_ID);
  const sub = (name: string, near = "50") => chain.subAccount(root, name, near);
  const deploy = async (name: string, code: Buffer, init: string, args: Record<string, unknown>, near = "50") => {
    const a = await sub(name, near);
    await a.signAndSendTransaction({ receiverId: a.accountId, actions: [actions.deployContract(code), actions.functionCall(init, args, 100n * TGAS, 0n)], waitUntil: "FINAL" });
    return a;
  };
  const usdc = await deploy("usdc", wasm("test_usdc.wasm"), "new", {});
  const U = usdc.accountId;
  const [ada, ben, alice, bob, carol, dave, mallory, council2] = await Promise.all(["ada", "ben", "alice", "bob", "carol", "dave", "mallory", "erin"].map((n) => sub(n)));
  let board: Account;
  if (opts.board === "dao") {
    // A Sputnik DAO: council = ada, ben and erin; a proposal passes with more than half the council.
    const policy = {
      roles: [{ name: "council", kind: { Group: [ada.accountId, ben.accountId, council2.accountId] }, permissions: ["*:*"], vote_policy: {} }],
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
      proposal_bond: milli(10).toString(),
      proposal_period: (7n * 24n * 3600n * 10n ** 9n).toString(),
      bounty_bond: milli(10).toString(),
      bounty_forgiveness_period: (24n * 3600n * 10n ** 9n).toString(),
    };
    board = await deploy("board", wasm("sputnikdao2-ZGdM2TFd.wasm"), "new", { config: { name: "acme-board", purpose: "The board of Acme Robotics, Inc.", metadata: "" }, policy });
  } else {
    board = await sub("board");
  }
  const B = board.accountId;
  const acme = await deploy("acme", opts.postmoney ?? postmoneyWasm(), "new", {
    owner_id: B,
    company: "Acme Robotics, Inc.",
    usdc: U,
    treasury: B,
    founders: [{ account: ada.accountId, shares: FOUNDERS[0].shares.toString() }, { account: ben.accountId, shares: FOUNDERS[1].shares.toString() }],
    options: (opts.options ?? 650_000n).toString(),
    pool: (opts.pool ?? 100_000n).toString(),
    rofr_secs: String(opts.rofrSecs ?? 4),
  });
  const A = acme.accountId;
  // Everyone holds test USDC and has storage balance on the cap table; the cap table and the board can receive USDC.
  const ok = (r: Result, what: string) => {
    if (!r.ok) throw new Error(`${what}: ${r.reason}`);
    return r;
  };
  ok(await call(root, U, "storage_deposit", { account_id: A }, milli(2)), "register acme");
  ok(await call(root, U, "storage_deposit", { account_id: B }, milli(2)), "register board");
  for (const who of [alice, bob, carol, dave, mallory, ada, ben]) {
    ok(await call(who, U, "mint", { amount: usd(1_000_000).toString() }, milli(2)), `mint ${who.accountId}`);
    ok(await call(who, A, "storage_deposit", {}, milli(50)), `storage ${who.accountId}`);
  }
  ok(await call(root, A, "storage_deposit", { account_id: B }, NEAR / 2n), "board storage");

  const view = <T = any>(method: string, args: Record<string, unknown> = {}) => chain.view<T>(A, method, args);
  const usdcOf = async (id: string) => BigInt(await chain.view<string>(U, "ft_balance_of", { account_id: id }));
  /** An investor (or anyone) pays the cap table through the token. */
  const pay = (who: Account, amount: bigint, msg: Record<string, unknown>, token = U) =>
    call(who, token, "ft_transfer_call", { receiver_id: A, amount: amount.toString(), msg: JSON.stringify(msg) }, 1n, 150n);
  /** The board acts: directly (plain owner), or by a Sputnik proposal that two of three council members approve. */
  const boardCall = async (method: string, args: Record<string, unknown>, o: { receiver?: string; deposit?: bigint; tgas?: bigint; why?: string } = {}): Promise<Result & { proposal?: number }> => {
    const receiver = o.receiver ?? A;
    if (opts.board !== "dao") return call(board, receiver, method, args, o.deposit ?? 0n, o.tgas ?? 250n);
    return daoAct([{ method, args, receiver, deposit: o.deposit, tgas: o.tgas }], o.why ?? method);
  };
  const daoAct = async (calls: { method: string; args: Record<string, unknown>; receiver?: string; deposit?: bigint; tgas?: bigint }[], why: string) => {
    const receiver = calls[0].receiver ?? A;
    const kind = { FunctionCall: { receiver_id: receiver, actions: calls.map((c) => ({ method_name: c.method, args: Buffer.from(JSON.stringify(c.args)).toString("base64"), deposit: (c.deposit ?? 0n).toString(), gas: ((c.tgas ?? 150n) * TGAS).toString() })) } };
    const p = await call(ada, B, "add_proposal", { proposal: { description: why, kind } }, milli(10), 50n);
    if (!p.ok) return { ...p, proposal: undefined };
    const id = p.value as number;
    const v1 = await call(ada, B, "act_proposal", { id, action: "VoteApprove", proposal: kind }, 0n, 300n);
    if (!v1.ok) return { ...v1, proposal: id };
    const v2 = await call(ben, B, "act_proposal", { id, action: "VoteApprove", proposal: kind }, 0n, 300n);
    const st = await chain.view<any>(B, "get_proposal", { id });
    // Sputnik marks a proposal Failed when its call fails; the contract's own refusal is in the receipts.
    return { ...v2, ok: v2.ok && st.status === "Approved", reason: v2.reason ?? (st.status !== "Approved" ? `proposal ${st.status}` : undefined), proposal: id };
  };
  const secs = () => chain.secs();
  const stop = () => stopSandbox(sandbox);
  return { sandbox, chain, root, usdc, U, acme, A, board, B, ada, ben, alice, bob, carol, dave, mallory, council2, view, usdcOf, pay, boardCall, daoAct, secs, stop, sleep, sub, deploy };
}

/** Stop the node within a time limit: near-sandbox's own teardown can wait forever on a node that already exited. */
export async function stopSandbox(sandbox: Sandbox, limitMs = 10_000): Promise<"stopped" | "killed"> {
  const p = (sandbox as unknown as { childProcess: ChildProcess }).childProcess;
  const exited = () => p.exitCode !== null || p.signalCode !== null;
  const gone = exited() ? Promise.resolve() : new Promise<void>((r) => p.once("exit", () => r()));
  if (!exited()) p.kill("SIGTERM");
  let how: "stopped" | "killed" = "stopped";
  if (!(await Promise.race([gone.then(() => true), sleep(limitMs).then(() => false)]))) {
    how = "killed";
    p.kill("SIGKILL");
    await Promise.race([gone, sleep(2_000)]);
  }
  await rm(sandbox.homeDir, { recursive: true, force: true }).catch(() => {});
  return how;
}

/** Print a suite's total, then stop its node (the total never waits on the teardown). Exits 1 on any failure. */
export async function finish(c: { count: number; fails: number }, label: string, ...stops: (() => unknown)[]): Promise<never> {
  console.log(`\n${c.count - c.fails}/${c.count} ${label}`);
  for (const s of stops) await Promise.race([Promise.resolve().then(s).catch(() => {}), sleep(15_000)]);
  process.exit(c.fails ? 1 : 0);
}
