import { accountUrl, COMPANY, EXPLORER } from "../../../src/chain.ts";
import { shares, short, usd, usdShort } from "../../../src/format.ts";
import type { Data } from "../data.ts";
import { Badge, Ext, type Tone } from "../ui.tsx";

const STATUS: Record<string, [Tone, string]> = {
  Closed: ["ok", "Closed"], Refunding: ["warn", "Refunded"], Open: ["info", "Open"], Closing: ["info", "Closing"],
};
const date = (secs: string | number) => new Date(Number(secs) * 1000).toISOString().slice(0, 10);

export function Safes({ d }: { d: Data }) {
  const { S } = d;
  const converted = S.priced_rounds.flatMap((pr) => JSON.parse(pr.preview).safes.map((s: any) => ({ ...s, round: pr.name, executed: pr.executed })));
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">SAFEs</p>
          <h1>Money in escrow, certificates on chain</h1>
          <p className="muted">Investors pay USDC into the contract. When the board closes a round, the money goes to the treasury and each investor gets an NFT certificate. A round that misses its minimum refunds everyone.</p>
        </div>
      </header>

      <section className="card flush">
        <div className="card-head"><h2>Rounds</h2></div>
        <ul className="rounds">
          {S.rounds.map((r: any) => {
            const t = r.terms.safe;
            const terms = [t.cap ? `${usdShort(t.cap)} cap` : "no cap", t.discount_bps ? `${t.discount_bps / 100}% discount` : "", t.mfn ? "MFN" : "", t.pro_rata ? "pro rata" : ""].filter(Boolean).join(" · ");
            const max = BigInt(r.terms.max_raise);
            const paid = r.investments.reduce((a: bigint, i: any) => a + BigInt(i.amount), 0n);
            const fill = Math.min(Number((paid * 10_000n) / max) / 100, 100);
            const minAt = Number((BigInt(r.terms.min_raise) * 10_000n) / max) / 100;
            const [tone, label] = STATUS[r.status] ?? ["neutral", r.status];
            return (
              <li key={r.id} className="round">
                <div className="round-top">
                  <span><b>{r.terms.name}</b><span className="muted small block">{terms}</span></span>
                  <Badge tone={tone}>{label}</Badge>
                </div>
                <div className="meter" aria-label={`${usd(paid)} of a ${usdShort(r.terms.min_raise)} minimum and ${usdShort(max)} maximum`}>
                  <span className={`meter-fill ${r.status === "Refunding" ? "refunded" : ""}`} style={{ width: `${fill}%` }} />
                  <span className="meter-min" style={{ left: `${minAt}%` }} title="minimum" />
                </div>
                <div className="round-bottom small">
                  <span className="mono">{usd(paid)} <span className="muted">of {usdShort(r.terms.min_raise)}–{usdShort(max)}</span></span>
                  <span className="muted">{r.investments.map((i: any) => `${short(i.investor)} ${usdShort(i.amount)}${i.refunded ? " (refunded)" : ""}`).join(", ") || "no investors"}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <div className="card-head"><h2>Outstanding certificates</h2><span className="muted small">NEP-171 tokens, drawn by the contract</span></div>
        {S.certificates.length ? (
          <div className="certs">
            {S.certificates.map((c: any) => {
              const x = JSON.parse(c.metadata.extra);
              return (
                <figure key={c.token_id} className="cert">
                  <img src={c.metadata.media} alt={c.metadata.title} loading="lazy" />
                  <figcaption>
                    <b>{c.metadata.title}</b>
                    <span className="muted small">held by <a href={accountUrl(c.owner_id)} target="_blank" rel="noreferrer">{short(c.owner_id)}</a>{x.amended_from_round !== null ? ` · MFN: took round ${x.round}'s terms` : ""}</span>
                    <Ext href={`${EXPLORER}/nft/${COMPANY}/${c.token_id}`}>Token {c.token_id}</Ext>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        ) : <p className="muted">No SAFE is outstanding.</p>}
      </section>

      {converted.length ? (
        <section className="card flush">
          <div className="card-head"><h2>Converted</h2><span className="muted small">Burned when the priced round executed</span></div>
          <ul className="rows padded">
            {converted.map((s: any) => (
              <li key={`${s.round}-${s.token_id}`}>
                <span><b>SAFE #{s.token_id}</b> <span className="muted">· {short(s.owner)} · {usd(s.purchase)} · {s.round}, {date(s.executed)}</span></span>
                <Badge tone={s.basis === "cap" ? "accent" : "info"}>{s.basis === "cap" ? "at its cap" : "at the round's price"}</Badge>
                <span className="mono strong right">{shares(s.shares)} shares</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
