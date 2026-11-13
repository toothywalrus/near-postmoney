// Acme Robotics' cap table, read from NEAR testnet. Every number here is the contract's: the cap table, the priced-round
// preview, the waterfall. With no RPC answering, the page shows web/public/snapshot.json (said so at the top) and models
// rounds and sales in the browser with the independent reference implementation (ref/reference.ts), also said so.
import "./style.css";
import { convert as refConvert, waterfall as refWaterfall, Refused, type Claim } from "../../ref/reference.ts";
import { accountUrl, BOARD, COMPANY, EXPLORER, finalBlock, txUrl, USDC, view, ViewError } from "./chain.ts";
import { esc, pct, price, shares, short, usd, usdShort } from "./format.ts";
import yc from "../../fixtures/yc-examples.json";

type Line = { holder: string; label: string; shares: string };
type State = {
  cap_table: any;
  rounds: any[];
  offers: any[];
  priced_rounds: any[];
  certificates: any[];
  proposals: any[];
  treasury_usdc: string;
  recorded_at?: string;
  block?: number;
};
const $ = (id: string) => document.getElementById(id)!;
let S: State;
let live = false;
let run: any = null;

// ---------- loading ----------
async function loadLive(): Promise<State> {
  const [cap_table, rounds, offers, priced_rounds, proposals, treasury_usdc, block] = await Promise.all([
    view(COMPANY, "cap_table"),
    view(COMPANY, "rounds"),
    view(COMPANY, "offers"),
    view(COMPANY, "priced_rounds"),
    view(BOARD, "get_proposals", { from_index: 0, limit: 100 }),
    view<string>(USDC, "ft_balance_of", { account_id: BOARD }),
    finalBlock(),
  ]);
  const certificates = await Promise.all(cap_table.certificates.map((c: any) => view(COMPANY, "nft_token", { token_id: c.token_id })));
  return { cap_table, rounds, offers, priced_rounds, proposals, treasury_usdc, certificates, block };
}

function setStatus() {
  const el = $("status");
  el.className = `status ${live ? "live" : "snapshot"}`;
  el.querySelector(".status-text")!.textContent = live
    ? `Live from NEAR testnet · block ${S.block?.toLocaleString("en-US")}`
    : `Recorded snapshot of testnet, ${new Date(S.recorded_at!).toUTCString().replace(/:\d\d GMT/, " UTC")} (testnet didn't answer)`;
}

// ---------- grouping holders into kinds ----------
const FOUNDERS = ["ada", "ben"];
function kindOf(l: { holder: string; label: string }): string {
  if (l.label.startsWith("SAFE #")) return "safe";
  if (l.label.includes("Safe Preferred")) return "safepref";
  if (l.label.startsWith("Options")) return "options";
  if (l.label.startsWith("Unissued")) return "pool";
  if (l.label === "Pool increase") return "poolnew";
  if (l.label === "Series B") return "seriesb";
  if (l.label === "Common") return l.holder === BOARD ? "treasury" : FOUNDERS.includes(short(l.holder)) ? "common" : "common2";
  return "seriesa";
}
const ORDER = ["common", "common2", "treasury", "seriesa", "safepref", "seriesb", "safe", "options", "pool", "poolnew"];
const who = (holder: string) => (holder === BOARD ? "Acme (bought back)" : holder === "series-b-lead.testnet" ? "New lead" : holder === "options" ? "Option holders" : holder === "pool" ? "Option pool" : short(holder));
const describe = (l: Line) => {
  if (l.label === "Common" && l.holder === BOARD) return "Common, held by the company";
  return l.label;
};

function sortLines(lines: Line[]): Line[] {
  return [...lines].sort((a, b) => ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b)) || Number(BigInt(b.shares) - BigInt(a.shares)));
}

function renderBar(el: HTMLElement, lines: Line[], total: bigint) {
  const sorted = sortLines(lines).filter((l) => BigInt(l.shares) > 0n);
  const keys = sorted.map((l) => `${l.holder}|${l.label}`);
  // Reuse segments by key so widths animate between states.
  const existing = new Map<string, HTMLElement>();
  el.querySelectorAll<HTMLElement>(".seg").forEach((s) => existing.set(s.dataset.key!, s));
  const frag: HTMLElement[] = [];
  sorted.forEach((l, i) => {
    let seg = existing.get(keys[i]);
    if (!seg) {
      seg = document.createElement("div");
      seg.className = `seg k-${kindOf(l)}`;
      seg.dataset.key = keys[i];
      seg.style.flexBasis = "0%";
    }
    existing.delete(keys[i]);
    const share = Number((BigInt(l.shares) * 1_000_000n) / total) / 10_000;
    seg.dataset.tip = `${who(l.holder)} · ${describe(l)}\n${shares(l.shares)} shares · ${share.toFixed(2)}%`;
    // Label a segment only with what fits: name and share, or just the name.
    const px = (el.clientWidth * share) / 100;
    const full = `${who(l.holder)} ${share.toFixed(1)}%`;
    const label = px > full.length * 7 + 14 ? full : px > who(l.holder).length * 7 + 12 ? who(l.holder) : "";
    seg.innerHTML = label ? `<span>${esc(label)}</span>` : "";
    frag.push(seg);
  });
  existing.forEach((s) => s.remove());
  el.replaceChildren(...frag);
  requestAnimationFrame(() => {
    sorted.forEach((l, i) => {
      frag[i].style.flexBasis = `${(Number((BigInt(l.shares) * 1_000_000n) / total) / 10_000).toFixed(4)}%`;
    });
  });
}

function renderLegend(el: HTMLElement, lines: Line[], total: bigint) {
  el.innerHTML = sortLines(lines)
    .map((l) => `<div class="row"><i class="sw k-${kindOf(l)}"></i><span class="who">${esc(who(l.holder))}<small>${esc(describe(l))}</small></span><span class="num">${shares(l.shares)}</span><span class="pc">${pct(BigInt(l.shares), total)}</span></div>`)
    .join("");
}

const sum = (lines: Line[]) => lines.reduce((a, l) => a + BigInt(l.shares), 0n);

// ---------- §1 ----------
function renderNow() {
  const lines: Line[] = S.cap_table.as_converted;
  const total = sum(lines);
  renderBar($("bar-now"), lines, total);
  renderLegend($("legend-now"), lines, total);
  const raised = S.rounds.filter((r) => r.status === "Closed").reduce((a, r) => a + BigInt(r.raised), 0n);
  const last = S.priced_rounds.at(-1);
  const facts: [string, string][] = [
    ["Board", `<a href="${accountUrl(BOARD)}">${esc(BOARD.split(".")[0])}</a><br><small>Sputnik DAO, 2 of 3 to pass</small>`],
    ["Cap table contract", `<a href="${accountUrl(COMPANY)}">${esc(COMPANY.replace(".testnet", ""))}</a><br><small>${shares(S.cap_table.version)} changes so far</small>`],
    ["Fully diluted", `<span class="num">${shares(total)}</span> shares`],
    ["Raised in SAFEs", `${usd(raised)} <small>tUSDC-TEST</small>`],
    ["Last priced round", last ? `${esc(last.name)} at <span class="num">${price(last.price)}</span>` : "none yet"],
  ];
  $("facts").innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

// ---------- §2: modelling the next round ----------
const logScale = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, t / 1000);
function nice(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
}
const LEAD = "series-b-lead.testnet";
let modelSeq = 0;

function modelInputs() {
  const pre = nice(logScale(+($("i-pre") as HTMLInputElement).value, 5e6, 200e6));
  const nw = nice(logScale(+($("i-new") as HTMLInputElement).value, 1e6, 50e6));
  const pool = +($("i-pool") as HTMLInputElement).value;
  $("o-pre").textContent = usdShort(BigInt(pre) * 1_000_000n);
  $("o-new").textContent = usdShort(BigInt(nw) * 1_000_000n);
  $("o-pool").textContent = `${pool}%`;
  return { pre: BigInt(pre) * 1_000_000n, nw: BigInt(nw) * 1_000_000n, pool };
}

/** The contract's preview, or offline the reference's result in the same shape. */
async function preview(pre: bigint, nw: bigint, pool: number): Promise<any> {
  const terms = { name: "Series B", pre_money: pre.toString(), investors: [{ account: LEAD, cash: nw.toString() }], pool: pool > 0 ? { target_bps: pool * 100 } : { increase: "0" }, price_decimals: 4 };
  if (live) return view(COMPANY, "preview_priced_round", { terms });
  const ct = S.cap_table;
  const cap = { outstanding: ct.positions.reduce((a: bigint, p: any) => a + BigInt(p.shares), 0n), options: BigInt(ct.options), pool: BigInt(ct.pool) };
  const safes = ct.certificates.map((c: any) => ({ purchase: BigInt(c.purchase), cap: c.terms.cap ? BigInt(c.terms.cap) : null, discount_bps: c.terms.discount_bps }));
  try {
    const r = refConvert(cap, safes, { pre_money: pre, new_money: [nw], pool: pool > 0 ? { target_bps: pool * 100 } : { increase: 0n }, price_decimals: 4 });
    return {
      price: `${r.price}`,
      state_hash: "",
      conversion: { company_capitalization: `${r.company_capitalization}`, pool_increase: `${r.pool_increase}`, pool_after: `${r.pool_after}`, new_shares_total: `${r.new_shares_total}`, post_money_shares: `${r.post_money_shares}` },
      safes: ct.certificates.map((c: any, i: number) => ({ token_id: c.token_id, owner: c.owner, purchase: c.purchase, discount_bps: c.terms.discount_bps, shares: `${r.safes[i].shares}`, basis: r.safes[i].basis, other_basis_shares: `${r.safes[i].other_basis_shares}` })),
      investors: [{ account: LEAD, cash: nw.toString(), shares: `${r.new_shares[0]}` }],
    };
  } catch (e) {
    if (e instanceof Refused) throw new ViewError(e.message);
    throw e;
  }
}

async function renderModel() {
  const { pre, nw, pool } = modelInputs();
  const seq = ++modelSeq;
  $("readout").classList.add("busy");
  let p: any;
  try {
    p = await preview(pre, nw, pool);
  } catch (e) {
    if (seq !== modelSeq) return;
    $("readout").className = "readout err";
    $("readout").textContent = e instanceof ViewError ? `The contract refuses these terms: ${e.message}.` : `Couldn't reach testnet: ${(e as Error).message}`;
    $("conversions").innerHTML = "";
    return;
  }
  if (seq !== modelSeq) return;
  const ct = S.cap_table;
  // After: every position as it is, options, the pool plus its increase, the SAFEs' new shares, the new money's.
  const after: Line[] = ct.as_converted.filter((l: Line) => !l.label.startsWith("SAFE #") && !l.label.startsWith("Unissued"));
  after.push({ holder: "pool", label: "Unissued option pool", shares: ct.pool });
  if (BigInt(p.conversion.pool_increase) > 0n) after.push({ holder: "pool", label: "Pool increase", shares: p.conversion.pool_increase });
  for (const s of p.safes) after.push({ holder: s.owner, label: s.basis === "cap" || s.discount_bps > 0 ? `Series B-${s.token_id} (Safe Preferred)` : "Series B", shares: s.shares });
  for (const i of p.investors) after.push({ holder: i.account, label: "Series B", shares: i.shares });
  const total = sum(after);
  renderBar($("bar-before"), ct.as_converted, sum(ct.as_converted));
  renderBar($("bar-after"), after, total);
  const newOwn = pct(BigInt(p.investors[0].shares), total);
  const founders = after.filter((l) => kindOf(l) === "common").reduce((a, l) => a + BigInt(l.shares), 0n);
  const cells: [string, string, string?][] = [
    ["Price per share", price(p.price)],
    ["Post-money", usdShort(pre + nw)],
    ["The new money buys", `${shares(p.investors[0].shares)}`, newOwn],
    ["Pool increase", shares(p.conversion.pool_increase), `to ${pool}%`],
    ["Founders after", pct(founders, total)],
    ["Fully diluted after", shares(p.conversion.post_money_shares)],
  ];
  $("readout").className = "readout";
  $("readout").innerHTML =
    cells.map(([k, v, x]) => `<div><b>${k}</b><span>${v}</span>${x ? ` <small class="num">${x}</small>` : ""}</div>`).join("") +
    (live ? `<div style="grid-column:1/-1"><b>The hash the board would vote on</b><span class="hash">${p.state_hash}</span></div>` : `<div style="grid-column:1/-1"><b>Offline</b><span class="hash">computed in your browser by the reference implementation (ref/reference.ts), not the contract</span></div>`);
  $("conversions").innerHTML = p.safes
    .map((s: any) => {
      const cert = ct.certificates.find((c: any) => c.token_id === s.token_id);
      const terms = [cert?.terms.cap ? `${usdShort(cert.terms.cap)} cap` : "no cap", cert?.terms.discount_bps ? `${cert.terms.discount_bps / 100}% discount` : ""].filter(Boolean).join(", ");
      const basis = s.basis === "cap" ? `<span class="tag cap">at its cap</span>` : `<span class="tag price">at the round's price${s.discount_bps ? ` × ${100 - s.discount_bps / 100}%` : ""}</span>`;
      const other = s.basis === "cap" ? `at the round's price: ${shares(s.other_basis_shares)}` : BigInt(s.other_basis_shares) > 0n ? `at its cap: ${shares(s.other_basis_shares)}` : "";
      return `<div class="conv"><div class="what">SAFE #${esc(s.token_id)} · ${esc(short(s.owner))} · ${usd(s.purchase)}${basis}<small>${esc(terms)}</small></div><div class="got">${shares(s.shares)} shares<small>${esc(other)}</small></div></div>`;
    })
    .join("");
}

// ---------- §3 ----------
function renderCerts() {
  $("cert-grid").innerHTML = S.certificates.length
    ? S.certificates
        .map((t: any) => {
          const x = JSON.parse(t.metadata.extra);
          const amended = x.amended_from_round !== null ? ` · MFN: adopted round ${x.round}'s terms` : "";
          return `<figure class="cert"><img src="${t.metadata.media}" alt="${esc(t.metadata.title)}" loading="lazy" /><figcaption><b>${esc(t.metadata.title)}</b><br>held by <a href="${accountUrl(t.owner_id)}">${esc(short(t.owner_id))}</a>${esc(amended)} · <a href="${EXPLORER}/nft/${COMPANY}/${t.token_id}">token ${esc(t.token_id)}</a></figcaption></figure>`;
        })
        .join("")
    : `<p class="note">No SAFE is outstanding.</p>`;
  const rows: string[] = [];
  for (const pr of S.priced_rounds) {
    const p = JSON.parse(pr.preview);
    for (const s of p.safes) {
      rows.push(`<div class="converted-row"><span>SAFE #${esc(s.token_id)} · ${esc(short(s.owner))} · ${usd(s.purchase)} <span class="tag ${s.basis}">${s.basis === "cap" ? "at its cap" : "at the round's price"}</span><br><small class="num">burned in the ${esc(pr.name)}, ${new Date(Number(pr.executed) * 1000).toISOString().slice(0, 10)}</small></span><span class="num">${shares(s.shares)} shares</span></div>`);
    }
  }
  $("converted").innerHTML = rows.join("") || `<p class="note">None yet.</p>`;
}

// ---------- §4 ----------
let exitSeq = 0;
async function waterfallAt(exit: bigint): Promise<any> {
  if (live) return view(COMPANY, "waterfall", { exit: exit.toString() });
  const ct = S.cap_table;
  const claims: Claim[] = [];
  const labels: [string, string][] = [];
  for (const c of ct.certificates) {
    claims.push({ safe: { purchase: BigInt(c.purchase), cap: c.terms.cap ? BigInt(c.terms.cap) : null } });
    labels.push([c.owner, `SAFE #${c.token_id}`]);
  }
  const common: any[] = [];
  for (const p of ct.positions) {
    if (ct.classes[p.class].preferred) {
      claims.push({ preferred: { shares: BigInt(p.shares), preference: BigInt(p.preference) } });
      labels.push([p.holder, ct.classes[p.class].name]);
    } else common.push(p);
  }
  const commonTotal = common.reduce((a, p) => a + BigInt(p.shares), 0n) + BigInt(ct.options);
  const w = refWaterfall(exit, commonTotal, claims);
  const lines = labels.map(([holder, label], i) => ({ holder, label, converts: w.claims[i].converts, shares: `${w.claims[i].shares}`, payout: `${w.claims[i].payout}` }));
  for (const p of common) lines.push({ holder: p.holder, label: "Common", converts: true, shares: p.shares, payout: `${(w.common_payout * BigInt(p.shares)) / commonTotal}` });
  if (BigInt(ct.options) > 0n) lines.push({ holder: "options", label: "Options (as exercised)", converts: true, shares: ct.options, payout: `${(w.common_payout * BigInt(ct.options)) / commonTotal}` });
  return { exit: exit.toString(), lines };
}

async function renderExit() {
  const exit = BigInt(nice(logScale(+($("i-exit") as HTMLInputElement).value, 2e6, 1e9))) * 1_000_000n;
  $("o-exit").textContent = usdShort(exit);
  const seq = ++exitSeq;
  let w: any;
  try {
    w = await waterfallAt(exit);
  } catch (e) {
    if (seq === exitSeq) $("waterfall").innerHTML = `<p class="note">${esc(String((e as Error).message))}</p>`;
    return;
  }
  if (seq !== exitSeq) return;
  const lines = [...w.lines].sort((a: any, b: any) => Number(BigInt(b.payout) - BigInt(a.payout)));
  const prefs = lines.filter((l: any) => !l.converts);
  const prefTotal = prefs.reduce((a: bigint, l: any) => a + BigInt(l.payout), 0n);
  const commonLines = lines.filter((l: any) => l.label === "Common" || l.label.startsWith("Options"));
  const perShare = commonLines.length ? (BigInt(commonLines[0].payout) * 1_000_000n) / BigInt(commonLines[0].shares) : 0n;
  $("waterfall").innerHTML =
    lines
      .map((l: any) => {
        const k = kindOf({ holder: l.holder, label: l.label.startsWith("Options") ? "Options" : l.label });
        const tag = l.label === "Common" || l.label.startsWith("Options") ? "" : l.converts ? `<span class="tag conv">converts</span>` : `<span class="tag pref">1x preference</span>`;
        const width = Number((BigInt(l.payout) * 100_000n) / exit) / 1000;
        return `<div class="wf"><div class="who">${esc(who(l.holder))}${tag}<small>${esc(l.label === "Common" && l.holder === BOARD ? "Common, held by the company" : l.label)}</small></div><div class="track"><div class="fill k-${k}" style="width:${width}%"></div></div><div class="amt">${usdShort(l.payout)}</div></div>`;
      })
      .join("") +
    `<p class="wf-summary">${prefs.length ? `${prefs.length} holder${prefs.length > 1 ? "s" : ""} take their 1x preference (${usdShort(prefTotal)} in all); ` : "Every preferred holder converts; "}common and everyone converting get ${price(perShare / 1_000_000n || 0n)} a share.</p>`;
}

// ---------- §5 ----------
function renderSeriesA() {
  const pr = S.priced_rounds.find((r) => r.name === "Series A");
  if (!pr) {
    $("compare").innerHTML = `<p class="note">Not executed yet.</p>`;
    return;
  }
  const p = JSON.parse(pr.preview);
  const e = yc.conversions[0].expect;
  const by = (acct: string) => p.investors.find((i: any) => short(i.account) === acct)?.shares;
  const rows: [string, string, string, boolean][] = [
    ["Company Capitalization", shares(e.company_capitalization), shares(p.conversion.company_capitalization), e.company_capitalization === p.conversion.company_capitalization],
    ["Investor A's SAFE ($200k, $4m cap): alice", shares(e.safe_shares[0]), shares(p.safes[0].shares), e.safe_shares[0] === p.safes[0].shares],
    ["Investor B's SAFE ($800k, $8m cap): bob", shares(e.safe_shares[1]), shares(p.safes[1].shares), e.safe_shares[1] === p.safes[1].shares],
    ["Series A price per share", price(e.price), price(p.price), e.price === p.price],
    ["Series A shares sold", shares(e.new_shares_total), shares(p.conversion.new_shares_total), e.new_shares_total === p.conversion.new_shares_total],
    ["Investor C, the lead: carol", shares(e.new_shares[0]), shares(by("carol")), e.new_shares[0] === by("carol")],
    ["Investor B's pro rata: bob", shares(e.new_shares[1]), shares(by("bob")), e.new_shares[1] === by("bob")],
    ["Other new investors: dave", shares(e.new_shares[2]), shares(by("dave")), e.new_shares[2] === by("dave")],
    ["Fully diluted after", shares(e.post_money_shares), shares(p.conversion.post_money_shares), e.post_money_shares === p.conversion.post_money_shares],
  ];
  const tx = run?.steps?.find((s: any) => typeof s.what === "string" && s.what.includes("votes: proposal 4"))?.tx;
  $("compare").innerHTML =
    `<div class="row head"><span></span><span class="num">YC's guide</span><span class="num">On chain</span><span></span></div>` +
    rows.map(([k, a, b, ok]) => `<div class="row"><span>${esc(k)}</span><span class="num">${a}</span><span class="num">${b}</span><span class="${ok ? "ok" : "no"}">${ok ? "✓" : "✗"}</span></div>`).join("") +
    `<p class="note" style="margin-top:14px">Executed by proposal 4 of the board${tx ? `, <a href="${txUrl(tx)}">the vote that ran it</a>` : ""}; the preview's hash was <code>${esc(pr.state_hash.slice(0, 16))}…</code>. The guide's pool after is 1,795,000; on chain it is ${shares(p.conversion.pool_after)} because the board granted one option between the preview and the vote (see §6).</p>`;
}

// ---------- §6 ----------
function renderBoard() {
  const stale = run?.staleDone;
  $("board-note").innerHTML = `<a href="${accountUrl(BOARD)}">${esc(BOARD)}</a> was made by the <code>sputnik-v2.testnet</code> factory. Its council is ada, ben and erin; a proposal passes with two votes. Every call below went from the DAO to the cap table, or to the token.`;
  const votesTx = (id: number) => run?.steps?.filter((s: any) => s.proposal === id && s.tx).map((s: any) => s.tx) ?? [];
  $("proposals").innerHTML = S.proposals
    .map((p: any) => {
      const methods = p.kind.FunctionCall?.actions.map((a: any) => a.method_name).join(", ") ?? Object.keys(p.kind)[0];
      const txs = votesTx(p.id);
      const refused = stale && stale.proposal === p.id ? `<div class="refused">Passed its vote; the cap table refused to execute it: “${esc(stale.refusal)}”. Nothing converted.</div>` : "";
      return `<li><span class="pid">#${p.id}</span><span>${esc(p.description)}<br><small class="num">${esc(methods)}</small></span><span class="st ${p.status}">${p.status}</span>${refused}${txs.length ? `<div class="links">${txs.map((t: string, i: number) => `<a href="${txUrl(t)}">${i === 0 ? "proposed" : "the vote that ran it"}</a>`).join("")}</div>` : ""}</li>`;
    })
    .join("");
}

// ---------- §7 ----------
function renderOffers() {
  const ct = S.cap_table;
  $("offers").innerHTML = S.offers.length
    ? S.offers
        .map((o: any) => {
          const what = { Settled: "Settled after the company's window: the shares went to the buyer, the money to the seller.", Matched: "The company bought them itself (right of first refusal); the buyer's escrow went back.", Funded: "Paid into escrow; the company's window is open.", AwaitingBuyer: "Waiting for the buyer to pay.", Cancelled: "Withdrawn by the seller.", Settling: "Settling." }[o.status as string] ?? o.status;
          return `<div class="offer"><span>${esc(short(o.seller))} → ${esc(short(o.buyer))} · ${shares(o.shares)} ${esc(ct.classes[o.class].name)}<small>${esc(what)}</small></span><span class="num">${usd(o.price)}</span></div>`;
        })
        .join("")
    : `<p class="note">None yet.</p>`;
}

// ---------- tooltip ----------
function wireTips() {
  const tip = $("tip");
  const show = (e: PointerEvent) => {
    const seg = (e.target as HTMLElement).closest<HTMLElement>(".seg");
    if (!seg) return (tip.hidden = true);
    tip.textContent = seg.dataset.tip ?? "";
    tip.style.whiteSpace = "pre-line";
    tip.hidden = false;
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${e.clientY + 16}px`;
  };
  document.addEventListener("pointermove", show);
  document.addEventListener("pointerdown", show);
  document.addEventListener("scroll", () => (tip.hidden = true), { passive: true });
}

function debounce(f: () => void, ms: number) {
  let t: number | undefined;
  return () => {
    clearTimeout(t);
    t = window.setTimeout(f, ms);
  };
}

async function main() {
  run = await fetch("./run.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  try {
    S = await loadLive();
    live = true;
  } catch {
    S = await fetch("./snapshot.json").then((r) => r.json());
    live = false;
  }
  setStatus();
  $("company").textContent = S.cap_table.company;
  if (!live) {
    document.querySelector("#model .note")!.textContent = "Testnet didn't answer, so this model runs in your browser on the recorded cap table, with the independent reference implementation (ref/reference.ts); on 2,500 random rounds it agrees with the contract on every number. Live, these numbers come from the contract's own preview_priced_round.";
    document.querySelector("#exit .note")!.textContent = "Testnet didn't answer: this waterfall runs in your browser with the reference implementation on the recorded cap table. Live, it is the contract's waterfall view.";
  }
  renderNow();
  renderCerts();
  renderSeriesA();
  renderBoard();
  renderOffers();
  const m = debounce(renderModel, 180);
  for (const id of ["i-pre", "i-new", "i-pool"]) $(id).addEventListener("input", () => { modelInputs(); m(); });
  const x = debounce(renderExit, 150);
  $("i-exit").addEventListener("input", () => { $("o-exit").textContent = usdShort(BigInt(nice(logScale(+($("i-exit") as HTMLInputElement).value, 2e6, 1e9))) * 1_000_000n); x(); });
  await Promise.all([renderModel(), renderExit()]);
  wireTips();
  $("links").innerHTML = `Contracts: <a href="${accountUrl(COMPANY)}">${COMPANY}</a> (the cap table), <a href="${accountUrl(USDC)}">${USDC}</a> (the test token), <a href="${accountUrl(BOARD)}">${BOARD}</a> (the board).`;
  document.body.dataset.ready = live ? "live" : "snapshot";
}
main();
