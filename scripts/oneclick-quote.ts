// "Invest from any chain", the mainnet path, priced without spending anything: keyless NEAR Intents 1Click quotes
// with `dry: true` (no deposit address is made, nothing executes).
//   1. An investor holding USDC on Base gets exactly $25,000 of USDC in their NEAR account, then sends it to the round
//      with ft_transfer_call {"invest": round}.
//   2. One step: 1Click delivers straight into the round, calling ft_transfer_call with
//      customRecipientMsg = {"invest": round, "for": "<investor>"} (decision 0007). Postmoney isn't on mainnet, so the
//      recipient here is a stand-in mainnet account; the quote shows 1Click accepts the message.
//   npm run quote                 (also: FROM=arb | eth | sol, AMOUNT=25000)
// (The request shape is from near-lab's spikes/oneclick-quote, our own MIT code.)
const API = "https://1click.chaindefuser.com/v0";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const FROM: Record<string, string> = {
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arb: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  eth: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  sol: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
};
const from = process.env.FROM ?? "base";
const dollars = BigInt(process.env.AMOUNT ?? "25000");
// Placeholders: a dry quote checks their format and sends nothing. A random EVM address (1Click rejects the burn address).
const refundTo = from === "sol" ? "11111111111111111111111111111112" : "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex");
const body = {
  dry: true,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: FROM[from],
  destinationAsset: USDC_NEAR,
  amount: (dollars * 1_000_000n).toString(),
  depositType: "ORIGIN_CHAIN",
  refundTo,
  refundType: "ORIGIN_CHAIN",
  recipient: "investor.near",
  recipientType: "DESTINATION_CHAIN",
  deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
};
let res: Response;
try {
  res = await fetch(`${API}/quote`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "postmoney-quote" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
} catch (e) {
  console.log(`SKIP: 1Click unreachable (${(e as Error).message})`);
  process.exit(3);
}
const data: any = await res.json();
if (!res.ok) {
  console.log(`1Click answered HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  process.exit(1);
}
const q = data.quote;
console.log(`An investor on ${from} pays ${q.amountInFormatted} USDC (≈ $${q.amountInUsd}) and gets ${q.amountOutFormatted} USDC on NEAR (min ${Number(q.minAmountOut) / 1e6}) in about ${q.timeEstimate} s.`);
console.log(`Overhead: ${(((Number(q.amountInUsd) - Number(q.amountOutUsd)) / Number(q.amountOutUsd)) * 100).toFixed(2)}%. Dry quote: no deposit address was created and nothing was executed.`);
console.log(`Next, on mainnet: usdc.ft_transfer_call({ receiver_id: <company contract>, amount: "${body.amount}", msg: '{"invest": <round>}' }).`);
const oneStep = { ...body, recipient: process.env.COMPANY_MAINNET ?? "wrap.near", customRecipientMsg: JSON.stringify({ invest: 0, for: "investor.near" }) };
const r2 = await fetch(`${API}/quote`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "postmoney-quote" }, body: JSON.stringify(oneStep), signal: AbortSignal.timeout(20_000) });
const d2: any = await r2.json();
if (r2.ok && d2.quoteRequest?.customRecipientMsg === oneStep.customRecipientMsg) {
  console.log(`One step: 1Click accepts delivering into a contract with customRecipientMsg ${d2.quoteRequest.customRecipientMsg} (quoted ${d2.quote.amountInFormatted} in, ${d2.quote.amountOutFormatted} out; recipient a stand-in, ${oneStep.recipient}).`);
} else {
  console.log(`One step: 1Click answered HTTP ${r2.status}: ${JSON.stringify(d2).slice(0, 200)}`);
  process.exit(1);
}
