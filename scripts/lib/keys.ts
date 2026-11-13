// (Copied from near-proof-of-capture's cli/src/keys.ts, which copied near-verdict's, then gave it a Linux keyring.) Account keys live in the OS
// keyring under the service `near-lab-testnet`, never in a file:
//   macOS: the login keychain (`security`);
//   Linux: the Secret Service (GNOME keyring and the like) through `secret-tool`
//          (lookup: `secret-tool lookup service near-lab-testnet account <id>`).
// With NO_KEYCHAIN set, or on a system with neither, a key made here lives in this process only and is
// forgotten when it exits (that's how a judge's fresh faucet account works).
import { execFileSync, spawnSync } from "node:child_process";

export const SERVICE = process.env.KEYCHAIN_SERVICE ?? "near-lab-testnet";
type Backend = "keychain" | "secret-tool" | "memory";
// secret-tool has no --version: run it bare (it prints its usage and exits 2) and only ask whether it exists.
const hasSecretTool = () => (spawnSync("secret-tool", [], { stdio: "ignore", timeout: 5000 }).error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
export const BACKEND: Backend = process.env.NO_KEYCHAIN
  ? "memory"
  : process.platform === "darwin"
    ? "keychain"
    : process.platform === "linux" && hasSecretTool()
      ? "secret-tool"
      : "memory";
const memory = new Map<string, string>();
const QUIET = { stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], timeout: 15_000 };

function keychainGet(account: string): string | undefined {
  try {
    if (BACKEND === "keychain") return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], QUIET).toString().trim() || undefined;
    if (BACKEND === "secret-tool") return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", account], QUIET).toString().trim() || undefined;
  } catch {
    return undefined;
  }
  return memory.get(account);
}

export function keychainSet(account: string, secret: string): void {
  if (BACKEND === "keychain") execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", secret]);
  // The key goes on stdin, so it is never in a process's arguments.
  else if (BACKEND === "secret-tool") execFileSync("secret-tool", ["store", "--label", account, "service", SERVICE, "account", account], { input: secret, stdio: ["pipe", "ignore", "pipe"], timeout: 15_000 });
  else memory.set(account, secret);
}

export function keychainDelete(account: string): void {
  if (BACKEND === "keychain") execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
  else if (BACKEND === "secret-tool") execFileSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore", timeout: 15_000 });
  else memory.delete(account);
}

export function keychainHas(account: string): boolean {
  return keychainGet(account) !== undefined;
}

export function keychainLoad(account: string): string {
  const v = keychainGet(account);
  if (!v) {
    const where = { keychain: `the macOS keychain (service ${SERVICE})`, "secret-tool": `the keyring (secret-tool, service ${SERVICE})`, memory: "this process (no keyring)" }[BACKEND];
    throw new Error(`no key for ${account} in ${where}`);
  }
  return v;
}
