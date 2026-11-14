import yc from "../../../../fixtures/yc-examples.json";
import { BOARD, txUrl } from "../../../src/chain.ts";
import { price, shares, short, usd, usdShort } from "../../../src/format.ts";
import { sum, type Data } from "../data.ts";
import { Badge, Ext, Icon, Legend, OwnershipBar, Stat } from "../ui.tsx";

export function Overview({ d }: { d: Data }) {
  const { S, run } = d;
  const ct = S.cap_table;
  const lines = ct.as_converted;
  const raised = S.rounds.filter((r) => r.status === "Closed").reduce((a, r) => a + BigInt(r.raised), 0n);
  const last = S.priced_rounds.at(-1);
  const stale = run?.staleDone;
  const fresh = run?.steps?.find((s) => typeof s.what === "string" && s.what.includes("votes: proposal 4"))?.tx;

  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">A cap table on NEAR · testnet</p>
          <h1>{ct.company}</h1>
          <p className="lead">Its SAFEs raise USDC into escrow, become NFTs, and convert themselves at the priced round, to the share. Its board is a Sputnik DAO that votes on the exact numbers.</p>
          <div className="hero-actions">
            <a className="btn primary" href="#/model">Model the next round<Icon name="arrow" size={15} /></a>
            <a className="btn" href="#/board">See the board's votes</a>
          </div>
        </div>
        {stale ? (
          <aside className="card moment" aria-labelledby="moment-h">
            <Badge tone="bad">Refused on chain</Badge>
            <h2 id="moment-h">The board voted on stale numbers. The contract said no.</h2>
            <ol className="moment-steps">
              <li><span className="n">1</span>The board previewed the Series A, then granted one option.</li>
              <li><span className="n bad"><Icon name="x" size={12} /></span>Proposal {stale.proposal} executed the old preview. It passed its vote; the cap table refused it: “{stale.refusal.split(":")[0]}”. <Ext href={txUrl(stale.tx)}>tx</Ext></li>
              <li><span className="n ok"><Icon name="check" size={12} /></span>Proposal {stale.proposal + 1} carried the fresh hash and converted the SAFEs. {fresh ? <Ext href={txUrl(fresh)}>tx</Ext> : null}</li>
            </ol>
          </aside>
        ) : null}
      </section>

      <div className="stats">
        <Stat label="Fully diluted" value={shares(sum(lines))} sub="shares" />
        <Stat label="Raised in SAFEs" value={usdShort(raised)} sub={`${S.rounds.filter((r) => r.status === "Closed").length} rounds closed`} />
        <Stat label="Last priced round" value={last ? price(last.price) : "—"} sub={last ? `${last.name}, per share` : "none yet"} />
        <Stat label="Treasury" value={usdShort(S.treasury_usdc)} sub="tUSDC-TEST, held by the board" />
        <Stat label="Board" value="2 of 3" sub={<a href={`https://testnet.nearblocks.io/address/${BOARD}`} target="_blank" rel="noreferrer">{short(BOARD)}</a>} />
      </div>

      <section className="card">
        <div className="card-head"><h2>Who owns Acme</h2><span className="muted small">Fully diluted, outstanding SAFEs at their cap</span></div>
        <OwnershipBar lines={lines} />
        <Legend lines={lines} />
      </section>

      <SeriesA d={d} />
    </>
  );
}

function SeriesA({ d }: { d: Data }) {
  const pr = d.S.priced_rounds.find((r) => r.name === "Series A");
  if (!pr) return null;
  const p = JSON.parse(pr.preview);
  const e = yc.conversions[0].expect;
  const by = (a: string) => p.investors.find((i: any) => short(i.account) === a)?.shares;
  const rows: [string, string, string][] = [
    ["Company Capitalization", e.company_capitalization, p.conversion.company_capitalization],
    ["alice's SAFE ($200k, $4m cap)", e.safe_shares[0], p.safes[0].shares],
    ["bob's SAFE ($800k, $8m cap)", e.safe_shares[1], p.safes[1].shares],
    ["Price per share", e.price, p.price],
    ["Series A shares sold", e.new_shares_total, p.conversion.new_shares_total],
    ["carol, the lead", e.new_shares[0], by("carol")],
    ["bob's pro rata", e.new_shares[1], by("bob")],
    ["dave", e.new_shares[2], by("dave")],
    ["Fully diluted after", e.post_money_shares, p.conversion.post_money_shares],
  ];
  const all = rows.every(([, a, b]) => a === b);
  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>The Series A, checked against YC</h2>
          <p className="muted small">Acme is the company in YC's <Ext href="https://www.ycombinator.com/documents">Post-Money Safe User Guide</Ext>, Example 1: $5m at $15m pre-money.</p>
        </div>
        {all ? <Badge tone="ok"><Icon name="check" size={12} />Matches on every line</Badge> : <Badge tone="bad">Differs</Badge>}
      </div>
      <table className="table">
        <thead><tr><th>Line</th><th className="num">YC's guide</th><th className="num">On chain</th><th className="num" aria-label="Match" /></tr></thead>
        <tbody>
          {rows.map(([k, a, b]) => {
            const fmt = (x: string) => (k === "Price per share" ? price(x) : shares(x));
            return (
              <tr key={k}>
                <td>{k}</td>
                <td className="num mono">{fmt(a)}</td>
                <td className="num mono">{b ? fmt(b) : "—"}</td>
                <td className="num">{a === b ? <span className="ok-mark"><Icon name="check" size={15} /></span> : <span className="neg"><Icon name="x" size={15} /></span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="card-foot muted small">Raised {usd(BigInt(p.investors.reduce((a: bigint, i: any) => a + BigInt(i.cash), 0n)))} from {p.investors.length} investors. The pool after differs from the guide's 1,795,000 only because the board granted one option between the preview and the vote.</p>
    </section>
  );
}
