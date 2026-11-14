import { accountUrl, BOARD, txUrl } from "../../../src/chain.ts";
import { shares, short, usd } from "../../../src/format.ts";
import type { Data } from "../data.ts";
import { Badge, Ext, Icon, type Tone } from "../ui.tsx";

const OFFER: Record<string, [Tone, string, string]> = {
  Settled: ["ok", "Settled", "After the company's window: shares to the buyer, money to the seller."],
  Matched: ["accent", "Company bought", "The company used its right of first refusal; the buyer's escrow went back."],
  Funded: ["info", "In escrow", "The company's window to buy them first is open."],
  AwaitingBuyer: ["neutral", "Awaiting buyer", "Waiting for the buyer to pay."],
  Cancelled: ["neutral", "Withdrawn", "Withdrawn by the seller."],
  Settling: ["info", "Settling", "Settling."],
};

export function Board({ d }: { d: Data }) {
  const { S, run } = d;
  const stale = run?.staleDone;
  const txsOf = (id: number) => run?.steps?.filter((s) => s.proposal === id && s.tx).map((s) => s.tx!) ?? [];
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Board</p>
          <h1>Every change is a vote</h1>
          <p className="muted">The board is <Ext href={accountUrl(BOARD)}>{short(BOARD)}</Ext>, a Sputnik DAO with three council members (ada, ben, erin). A proposal passes with two votes, and only the DAO can change the cap table.</p>
        </div>
      </header>

      <section className="card flush">
        <div className="card-head"><h2>Proposals</h2><span className="muted small">{S.proposals.length} in all</span></div>
        <ol className="proposals">
          {S.proposals.map((p: any) => {
            const methods = p.kind.FunctionCall?.actions.map((a: any) => a.method_name).join(", ") ?? Object.keys(p.kind)[0];
            const refused = stale && stale.proposal === p.id;
            const txs = txsOf(p.id);
            return (
              <li key={p.id} className={refused ? "refused" : ""}>
                <span className="pid mono">#{p.id}</span>
                <div className="prop-body">
                  <span>{p.description}</span>
                  <span className="muted small mono">{methods}</span>
                  {refused ? <span className="refusal small"><Icon name="alert" size={13} />Passed its vote, but the cap table refused it: “{stale!.refusal.split(":")[0]}”. Nothing converted.</span> : null}
                </div>
                <div className="prop-side">
                  {refused ? <Badge tone="bad">Refused</Badge> : <Badge tone={p.status === "Approved" ? "ok" : p.status === "Rejected" ? "bad" : "neutral"}>{p.status}</Badge>}
                  {txs.length ? <span className="prop-links small">{txs.map((t, i) => <Ext key={t} href={txUrl(t)}>{i === 0 ? "proposed" : "vote"}</Ext>)}</span> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="card flush">
        <div className="card-head">
          <div><h2>Secondary sales</h2><p className="muted small">A holder offers shares to a buyer, the buyer pays into escrow, and the company may buy them first at that price.</p></div>
        </div>
        {S.offers.length ? (
          <ul className="rows padded">
            {S.offers.map((o: any) => {
              const [tone, label, what] = OFFER[o.status] ?? ["neutral", o.status, ""];
              return (
                <li key={o.id}>
                  <span><b>{short(o.seller)} → {short(o.buyer)}</b> <span className="muted">· {shares(o.shares)} {S.cap_table.classes[o.class].name}</span><span className="muted small block">{what}</span></span>
                  <Badge tone={tone}>{label}</Badge>
                  <span className="mono strong right">{usd(o.price)}</span>
                </li>
              );
            })}
          </ul>
        ) : <p className="muted pad">None yet.</p>}
      </section>
    </>
  );
}
