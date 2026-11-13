// npm run judge: the core checks in one command, no keys, no wallet, no Rust (the wasm is checked in under res/).
// Needs Node 22 and, the first time, the network (near-sandbox downloads its node; the testnet re-read uses an RPC).
//   fast (default): wasm sums; the reference on YC's examples and 2,000 random rounds; the contract's wasm vs the
//                   reference on a local sandbox; the attack suite; the company's whole life with a real Sputnik DAO
//                   board; three mutation checks; the testnet deployment re-read; the web page builds.
//   --full:         also all 20 mutation checks, page screenshots (Playwright), and the Rust tests if cargo or the
//                   judge-full Docker image is present.
// Suites run side by side; each prints as it finishes; the table comes last. A suite that can't reach testnet is SKIP.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FULL = process.argv.includes("--full");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = `${ROOT}node_modules/.bin/tsx`;
type Row = { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string; secs: number };
const rows: Row[] = [];
const t0 = Date.now();
const last = (out: string, re: RegExp) => out.split("\n").filter((l) => re.test(l)).pop()?.trim() ?? "";

function run(name: string, cmd: string, args: string[], summarize: (out: string) => string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const t = Date.now();
  console.log(`▶ ${name}`);
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const secs = Math.round((Date.now() - t) / 1000);
      const status = code === 3 ? "SKIP" : code === 0 ? "PASS" : "FAIL";
      const detail = status === "SKIP" ? last(out, /^SKIP/) || "testnet unreachable" : summarize(out).replace(/ \(\d+ s\)$/, "") || `exit ${code}`;
      rows.push({ name, status, detail, secs });
      console.log(`${status === "PASS" ? "✓" : status === "SKIP" ? "–" : "✗"} ${name} (${secs} s): ${detail}`);
      if (status === "FAIL") console.log(out.split("\n").filter((l) => /✗|Error|FAILED|panicked/.test(l)).slice(0, 12).join("\n"));
      done();
    });
  });
}

// 1. The wasm a judge runs, and testnet holds, is what's checked in.
const sums = readFileSync(`${ROOT}res/SHA256SUMS`, "utf8").trim().split("\n");
const bad = sums.filter((l) => {
  const [h, f] = l.split(/\s+/);
  return createHash("sha256").update(readFileSync(`${ROOT}res/${f}`)).digest("hex") !== h;
});
rows.push({ name: "res/*.wasm match res/SHA256SUMS", status: bad.length ? "FAIL" : "PASS", detail: bad.length ? bad.join("; ") : sums.map((l) => l.split(/\s+/)[1]).join(", "), secs: 0 });

const suites: Promise<void>[] = [
  run("Reference: YC's worked examples + invariants on 2,000 random rounds and 2,000 exits", TSX, ["scripts/reference-check.ts"], (o) => `${(o.match(/^✓/gm) ?? []).length} ✓, ${(o.match(/^✗/gm) ?? []).length} ✗; ${last(o, /invariants hold/).replace(/^✓ /, "").slice(0, 70)}…`),
  run("Kill test on the wasm: contract vs reference, every number (sandbox)", TSX, ["scripts/property.ts"], (o) => last(o, /wasm = reference on \d+ random priced/).replace(/^✓ /, "").replace(/ \(0 disagree.*$/, "").trim() + `; ${last(o, /property checks/).replace(/ \(\d+ s\)$/, "")}`),
  run("Attack suite: each attack meets its stated refusal (sandbox)", TSX, ["scripts/attacks.ts"], (o) => last(o, /attacks refused/)),
  run("The company's whole life, board = real Sputnik DAO (sandbox)", TSX, ["scripts/sandbox.ts"], (o) => last(o, /sandbox checks/)),
  run(FULL ? "Mutation checks: all 20" : "Mutation checks: 3 of 20 (npm run mutants runs all)", TSX, ["scripts/mutants.ts", ...(FULL ? [] : ["--quick"])], (o) => last(o, /mutants caught/), { PARALLEL: FULL ? "4" : "3" }),
  run("Testnet deployment re-read from chain state", TSX, ["scripts/verify.ts"], (o) => last(o, /chain checks/)),
  run("Web page builds (web/dist)", "npm", ["run", "-s", "build:web"], (o) => (/built in/.test(o) ? "built: serve web/dist with any static server" : "")),
];
await Promise.all(suites);
if (FULL) {
  await run("Page: desktop and phone, live and snapshot (Playwright)", TSX, ["scripts/shots.ts"], (o) => last(o, /page checks|FAILED/));
  const hasCargo = spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;
  const hasDocker = spawnSync("docker", ["image", "inspect", "judge-full:latest"], { stdio: "ignore" }).status === 0;
  if (hasCargo || hasDocker) await run("Rust: safe-math unit tests and the reference's 4,000 cases", "sh", ["scripts/cargo.sh", "test", "-p", "safe-math"], (o) => `${[...o.matchAll(/test result: ok\. (\d+) passed/g)].reduce((a, m) => a + Number(m[1]), 0)} passed`);
  else rows.push({ name: "Rust tests", status: "SKIP", detail: "no cargo and no judge-full image", secs: 0 });
}

const w = Math.max(...rows.map((r) => r.name.length));
console.log(`\n${"Check".padEnd(w)}  Result  Time   Detail`);
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(6)}  ${`${r.secs}s`.padEnd(5)}  ${r.detail}`);
const failed = rows.filter((r) => r.status === "FAIL").length;
console.log(`\n${failed ? `${failed} FAILED` : `All ${rows.filter((r) => r.status === "PASS").length} checks passed${rows.some((r) => r.status === "SKIP") ? " (some skipped)" : ""}`} in ${Math.round((Date.now() - t0) / 1000)} s.`);
console.log("Not run here, by design: npm run deploy and npm run demo (they sign testnet transactions with the deployer's keys).");
process.exit(failed ? 1 : 0);
