export const MICRO = 1_000_000n;
const nf = new Intl.NumberFormat("en-US");
export const shares = (x: bigint | string | number) => nf.format(BigInt(x));
/** $1,234,567 (cents only when there are any). */
export function usd(micro: bigint | string): string {
  const m = BigInt(micro);
  const d = m / MICRO;
  const c = (m % MICRO) / 10_000n;
  return `$${nf.format(d)}${c ? `.${c.toString().padStart(2, "0")}` : ""}`;
}
/** $12.5m, $800k */
export function usdShort(micro: bigint | string | number): string {
  const d = Number(BigInt(micro) / MICRO);
  if (d >= 1e9) return `$${+(d / 1e9).toFixed(2)}bn`;
  if (d >= 1e6) return `$${+(d / 1e6).toFixed(d >= 1e7 ? 1 : 2)}m`;
  if (d >= 1e3) return `$${+(d / 1e3).toFixed(0)}k`;
  return `$${d}`;
}
export const price = (micro: bigint | string) => `$${(Number(BigInt(micro)) / 1e6).toFixed(4)}`;
export const pct = (part: bigint, whole: bigint, digits = 2) => (whole === 0n ? "0%" : `${(Number((part * 10n ** 8n) / whole) / 1e6).toFixed(digits)}%`);
export const short = (account: string) => account.split(".")[0];
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
