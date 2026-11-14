import { useEffect, useRef, useState } from "react";
import { ViewError } from "../../../src/chain.ts";
import { pct, price, shares, short, usd, usdShort } from "../../../src/format.ts";
import { afterRound, dollars, kindOf, logScale, nice, preview, sum, waterfallAt, who, type Data } from "../data.ts";
import { Badge, Icon, OwnershipBar } from "../ui.tsx";

/** Run the latest request only: a slow answer to an old slider position never overwrites a newer one. */
function useLatest<T>(f: () => Promise<T>, deps: unknown[], delay = 160): { value: T | null; error: string | null; busy: boolean } {
  const [state, setState] = useState<{ value: T | null; error: string | null; busy: boolean }>({ value: null, error: null, busy: true });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, busy: true }));
    const t = setTimeout(() => {
      f().then(
        (value) => { if (n === seq.current) setState({ value, error: null, busy: false }); },
        (e) => { if (n === seq.current) setState({ value: null, error: e instanceof ViewError ? `The contract refuses these terms: ${e.message}.` : `Couldn't reach testnet: ${(e as Error).message}`, busy: false }); },
      );
    }, delay);
    return () => clearTimeout(t);
  }, deps);
  return state;
}

export function Model({ d }: { d: Data }) {
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Model</p>
          <h1>What the next round does to Acme</h1>
          <p className="muted">{d.live ? "Every number here comes from the contract's own views, the ones the board votes on." : "Offline: computed in your browser by the reference implementation, which agrees with the contract on 2,500 random rounds."}</p>
        </div>
      </header>
      <NextRound d={d} />
      <Exit d={d} />
    </>
  );
}

function NextRound({ d }: { d: Data }) {
  const [tPre, setPre] = useState(560);
  const [tNew, setNew] = useState(500);
  const [pool, setPool] = useState(12);
  const pre = nice(logScale(tPre, 5e6, 200e6));
  const nw = nice(logScale(tNew, 1e6, 50e6));
  const ct = d.S.cap_table;
  const { value: p, error, busy } = useLatest(() => preview(d, dollars(pre), dollars(nw), pool), [pre, nw, pool]);
  const after = p ? afterRound(ct, p) : null;
  const total = after ? sum(after) : 0n;
  const founders = after ? after.filter((l) => kindOf(l) === "common").reduce((a, l) => a + BigInt(l.shares), 0n) : 0n;
  const foundersNow = sum(ct.as_converted.filter((l: any) => kindOf(l) === "common"));

  return (
    <section className="card">
      <div className="card-head"><h2>The next priced round</h2>{busy ? <span className="muted small"><span className="spinner sm" aria-hidden="true" /> asking the contract</span> : null}</div>
      <div className="sliders three">
        <Slider label="Pre-money valuation" value={usdShort(dollars(pre))} t={tPre} set={setPre} />
        <Slider label="New money" value={usdShort(dollars(nw))} t={tNew} set={setNew} />
        <Slider label="Unissued pool after" value={`${pool}%`} t={pool} set={setPool} max={25} />
      </div>

      {error ? <div className="alert bad small"><Icon name="alert" /><div>{error}</div></div> : null}

      <div className="compare-bars">
        <div className="bar-row"><span className="bar-label">Today</span><OwnershipBar lines={ct.as_converted} thin /></div>
        <div className="bar-row"><span className="bar-label">After</span>{after ? <OwnershipBar lines={after} /> : <div className="own-bar placeholder" />}</div>
      </div>

      {p ? (
        <>
          <div className="readout">
            <div><span>Price per share</span><b className="mono">{price(p.price)}</b></div>
            <div><span>Post-money</span><b className="mono">{usdShort(dollars(pre + nw))}</b></div>
            <div><span>New lead gets</span><b className="mono">{pct(BigInt(p.investors[0].shares), total)}</b></div>
            <div><span>Pool top-up</span><b className="mono">{shares(p.conversion.pool_increase)}</b></div>
            <div><span>Founders</span><b className="mono">{pct(foundersNow, sum(ct.as_converted), 1)} → {pct(founders, total, 1)}</b></div>
          </div>
          {p.safes.length ? (
            <div className="sub-section">
              <h3>The SAFEs convert</h3>
              <ul className="rows">
                {p.safes.map((s: any) => (
                  <li key={s.token_id}>
                    <span><b>SAFE #{s.token_id}</b> <span className="muted">· {short(s.owner)} · {usd(s.purchase)}</span></span>
                    <Badge tone={s.basis === "cap" ? "accent" : "info"}>{s.basis === "cap" ? "at its cap" : `at the round's price${s.discount_bps ? ` −${s.discount_bps / 100}%` : ""}`}</Badge>
                    <span className="mono strong right">{shares(s.shares)} shares</span>
                  </li>
                ))}
              </ul>
              <p className="muted small">Each SAFE takes whichever gives more shares: its cap, or the round's price less its discount.</p>
            </div>
          ) : null}
          {d.live && p.state_hash ? <p className="hash small"><span className="muted">The hash the board would vote on</span><code>{p.state_hash}</code></p> : null}
        </>
      ) : null}
    </section>
  );
}

function Exit({ d }: { d: Data }) {
  const [t, setT] = useState(520);
  const exit = nice(logScale(t, 2e6, 1e9));
  const { value: w, error } = useLatest(() => waterfallAt(d, dollars(exit)), [exit], 120);
  const lines = w ? [...w.lines].sort((a, b) => Number(BigInt(b.payout) - BigInt(a.payout))) : [];
  const max = lines.length ? BigInt(lines[0].payout) || 1n : 1n;
  const prefs = lines.filter((l) => !l.converts);
  return (
    <section className="card">
      <div className="card-head"><h2>If Acme is sold</h2><span className="muted small">Preferred take 1x back or convert, whichever pays more</span></div>
      <div className="sliders"><Slider label="Sale price" value={usdShort(dollars(exit))} t={t} set={setT} /></div>
      {error ? <div className="alert bad small"><Icon name="alert" /><div>{error}</div></div> : null}
      <ul className="wf">
        {lines.map((l) => {
          const plain = l.label === "Common" || l.label.startsWith("Options");
          return (
            <li key={`${l.holder}|${l.label}`}>
              <span className="wf-who"><b>{who(l.holder)}</b><span className="muted small">{l.label}</span></span>
              <span className="wf-tag">{plain ? null : l.converts ? <Badge tone="neutral">converts</Badge> : <Badge tone="accent">1x back</Badge>}</span>
              <span className="wf-track"><span className={`wf-fill k-${kindOf({ holder: l.holder, label: l.label.startsWith("Options") ? "Options" : l.label })}`} style={{ width: `${Number((BigInt(l.payout) * 1000n) / max) / 10}%` }} /></span>
              <span className="mono wf-amt">{usdShort(l.payout)}</span>
            </li>
          );
        })}
      </ul>
      {lines.length ? <p className="muted small">{prefs.length ? `${prefs.length} preferred holder${prefs.length > 1 ? "s take" : " takes"} their money back; everyone else converts to common.` : "At this price every preferred holder converts to common."}</p> : null}
    </section>
  );
}

function Slider({ label, value, t, set, max = 1000 }: { label: string; value: string; t: number; set: (n: number) => void; max?: number }) {
  return (
    <label className="slider">
      <span className="slider-top"><span className="muted">{label}</span><b className="mono">{value}</b></span>
      <input type="range" min="0" max={max} value={t} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
}
