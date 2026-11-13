// Mutation checks: break one security- or math-critical line of the contract, and a suite must catch it.
//   npm run mutants             run the attack suite or the property test on every prebuilt mutant in res/mutants/
//   npm run mutants -- --quick  three of them (what npm run judge runs)
//   npm run mutants -- --build  rebuild res/mutants/*.wasm.gz from the source (needs Docker and the judge-full image)
// Each mutant is the real contract with exactly one change below, built with the same toolchain as res/postmoney.wasm.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
type Mutant = { id: string; what: string; file: string; find: string; replace: string; suite: "attacks" | "property" };
const PM = "contracts/postmoney/src/lib.rs";
const SM = "contracts/safe-math/src/lib.rs";
export const MUTANTS: Mutant[] = [
  { id: "no-board-check", what: "anyone may act as the board", file: PM, suite: "attacks",
    find: `require!(env::predecessor_account_id() == self.owner, "only the board (the company's DAO) can do this");`, replace: `let _ = &self.owner;` },
  { id: "any-token", what: "any token counts as USDC", file: PM, suite: "attacks",
    find: `require!(token == self.usdc, "unknown token: this company only takes its USDC");`, replace: `let _ = &token;` },
  { id: "no-max", what: "a round keeps money over its max", file: PM, suite: "attacks",
    find: `let take = amount.min(room);`, replace: `let take = amount;` },
  { id: "free-storage", what: "storage isn't charged to the investor", file: PM, suite: "attacks",
    find: `self.set_storage(who, have - cost);`, replace: `self.set_storage(who, have);` },
  { id: "double-refund", what: "a refund doesn't mark itself paid", file: PM, suite: "attacks",
    find: `r.investments[i].refunded = true;`, replace: `r.investments[i].refunded = false;` },
  { id: "refund-to-caller", what: "a refund goes to whoever asks", file: PM, suite: "attacks",
    find: `ft_transfer(&token, &investor, amount, "SAFE round refund")`, replace: `ft_transfer(&token, &env::predecessor_account_id(), amount, "SAFE round refund")` },
  { id: "refund-early", what: "a funded round becomes refundable the moment its deadline passes, before the board can close it", file: PM, suite: "attacks",
    find: `let abandoned = now >= deadline.saturating_add(deadline.saturating_sub(opened));`, replace: `let abandoned = now >= deadline || opened == 0;` },
  { id: "close-twice", what: "a closed round can be closed again", file: PM, suite: "attacks",
    find: `require!(r.status == RoundStatus::Open, "the round is not open");\n        require!(r.raised.0 >= r.terms.min_raise.0`, replace: `require!(r.raised.0 >= r.terms.min_raise.0` },
  { id: "no-hash-check", what: "the board's execution ignores the previewed hash", file: PM, suite: "attacks",
    find: `require!(p.state_hash == expected_hash, `, replace: `require!(p.state_hash == expected_hash || true, ` },
  { id: "consent-any-receiver", what: "a consent for one receiver lets the SAFE go to anyone", file: PM, suite: "attacks",
    find: `.position(|(t, r)| *t == token_id && *r == receiver_id);`, replace: `.position(|(t, _r)| *t == token_id);` },
  { id: "no-rofr-window", what: "a sale settles inside the company's window", file: PM, suite: "attacks",
    find: `require!(now_secs() >= o.window_ends.0, `, replace: `require!(now_secs() + 1_000_000 >= o.window_ends.0, ` },
  { id: "rofr-anyone", what: "anyone may exercise the company's right of first refusal", file: PM, suite: "attacks",
    find: `require!(payer == self.treasury || payer == self.owner, `, replace: `require!(payer == self.treasury || payer != self.owner, ` },
  { id: "close-no-rollback", what: "a failed payout to the treasury still closes the round", file: PM, suite: "attacks",
    find: `self.round_mut(round).status = RoundStatus::Open;`, replace: `self.round_mut(round).status = RoundStatus::Closed;` },
  { id: "settle-no-rollback", what: "a failed payout to the seller leaves the buyer with the shares", file: PM, suite: "attacks",
    find: `self.move_shares(&o.buyer, &o.seller, o.class, o.shares.0, true);`, replace: `` },
  { id: "ceil-company-cap", what: "Company Capitalization rounded up instead of down", file: SM, suite: "property",
    find: `to_u128(&Q::int(num).div(&Q::int(1).sub(&alpha)).floor())`, replace: `to_u128(&(Q::int(num).div(&Q::int(1).sub(&alpha)).floor() + BigInt::one()))` },
  { id: "no-pool-shuffle", what: "the pool increase left out of the pre-money (the spreadsheet error)", file: SM, suite: "property",
    find: `Pool::Increase(inc) => with_increase(inc),`, replace: `Pool::Increase(_inc) => with_increase(0),` },
  { id: "pre-money-safe", what: "SAFEs left out of their own Company Capitalization (pre-money SAFE math)", file: SM, suite: "property",
    find: `            } else if let Some(cp) = s.cap {\n                alpha = alpha.add(&Q::frac(s.purchase, cp));\n            }\n        }\n        to_u128(`, replace: `            } else if let Some(_cp) = s.cap {\n            }\n        }\n        to_u128(` },
  { id: "always-cap", what: "a capped SAFE never takes the round's price, even when that gives more shares", file: SM, suite: "property",
    find: `if at_price[i] > mul_div(k, safes[i].purchase, cp)? {`, replace: `if false && at_price[i] > mul_div(k, safes[i].purchase, cp)? {` },
  { id: "wrong-way-conversion", what: "preferred converts when converting pays less", file: SM, suite: "property",
    find: `let wants = split(exit, common, claims, &with)?.pay[i] > split(exit, common, claims, &without)?.pay[i];`, replace: `let wants = split(exit, common, claims, &with)?.pay[i] < split(exit, common, claims, &without)?.pay[i];` },
];
const QUICK = ["no-hash-check", "refund-to-caller", "no-pool-shuffle"];

if (process.argv.includes("--build")) {
  const work = join(tmpdir(), `postmoney-mutants-${process.getuid?.() ?? 0}`);
  mkdirSync(join(ROOT, "res/mutants"), { recursive: true });
  for (const m of MUTANTS) {
    rmSync(join(work, "contracts"), { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    cpSync(join(ROOT, "contracts"), join(work, "contracts"), { recursive: true, filter: (src) => !src.includes("/target") });
    const f = join(work, m.file);
    const text = readFileSync(f, "utf8");
    if (text.split(m.find).length !== 2) throw new Error(`${m.id}: the line to mutate must appear exactly once`);
    writeFileSync(f, text.replace(m.find, m.replace));
    const crate = m.file.includes("safe-math") ? "postmoney" : "postmoney";
    execFileSync("docker", ["run", "--rm", "--user", `${process.getuid?.()}:${process.getgid?.()}`, "-e", "HOME=/tmp", "-e", "CARGO_HOME=/usr/local/cargo", "-e", "CARGO_TARGET_DIR=/w/target",
      "-v", `${work}:/w`, "-v", "near-r9-cargo-registry:/usr/local/cargo/registry", "-w", `/w/contracts/${crate}`, "judge-full:latest",
      "cargo", "near", "build", "non-reproducible-wasm", "--locked", "--no-abi"], { stdio: ["ignore", "ignore", "inherit"] });
    writeFileSync(join(ROOT, `res/mutants/${m.id}.wasm.gz`), gzipSync(readFileSync(join(work, "target/near/postmoney/postmoney.wasm")), { level: 9 }));
    console.log(`built res/mutants/${m.id}.wasm.gz (${m.what})`);
  }
  process.exit(0);
}

const list = process.argv.includes("--quick") ? MUTANTS.filter((m) => QUICK.includes(m.id)) : MUTANTS;
const TSX = join(ROOT, "node_modules/.bin/tsx");
const t0 = Date.now();
function run(m: Mutant): Promise<{ m: Mutant; caught: boolean; detail: string }> {
  const file = join(ROOT, `res/mutants/${m.id}.wasm.gz`);
  if (!existsSync(file)) return Promise.resolve({ m, caught: false, detail: "not built (npm run mutants -- --build)" });
  return new Promise((done) => {
    const p = spawn(TSX, [join(ROOT, `scripts/${m.suite}.ts`)], { cwd: ROOT, env: { ...process.env, POSTMONEY_WASM: file, FRESH: "0", ...(m.suite === "attacks" ? { STOP_ON_FAIL: "1" } : {}) } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const first = out.split("\n").find((l) => l.startsWith("✗"))?.slice(2, 110) ?? "";
      done({ m, caught: code !== 0, detail: code !== 0 ? `caught by ${m.suite}: ${first}` : `NOT caught: ${m.suite} passed` });
    });
  });
}
const results: Awaited<ReturnType<typeof run>>[] = [];
let next = 0;
await Promise.all(Array.from({ length: Number(process.env.PARALLEL ?? 4) }, async () => {
  while (next < list.length) {
    const r = await run(list[next++]);
    results.push(r);
    console.log(`${r.caught ? "✓" : "✗"} ${r.m.id}: ${r.m.what}  (${r.detail})`);
  }
}));
const caught = results.filter((r) => r.caught).length;
console.log(`\n${caught}/${list.length} mutants caught (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(caught === list.length ? 0 : 1);
