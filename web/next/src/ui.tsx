import type { ReactNode } from "react";
import { pct, shares } from "../../src/format.ts";
import { describe, kindOf, sortLines, sum, who, type Line } from "./data.ts";

type IconName = "sun" | "moon" | "arrow" | "check" | "x" | "external" | "alert" | "shield" | "chevron" | "users" | "file";
const PATHS: Record<IconName, ReactNode> = {
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  alert: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.01" /></>,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" /></>,
  file: <><path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></>,
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="mark-plate" />
      <path d="M11 24V8h6.5a5 5 0 0 1 0 10H11" className="mark-p" fill="none" strokeWidth="3" />
    </svg>
  );
}

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral" | "accent";
export const Badge = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a className="ext" href={href} target="_blank" rel="noreferrer">{children}<Icon name="external" size={12} /></a>;
}

/** Ownership as one stacked bar. Each segment names its holder when the name fits, and says everything on hover. */
export function OwnershipBar({ lines, thin }: { lines: Line[]; thin?: boolean }) {
  const total = sum(lines);
  const sorted = sortLines(lines).filter((l) => BigInt(l.shares) > 0n);
  return (
    <div className={`own-bar ${thin ? "thin" : ""}`} role="img" aria-label={sorted.map((l) => `${who(l.holder)} ${pct(BigInt(l.shares), total, 1)}`).join(", ")}>
      {sorted.map((l) => {
        const share = Number((BigInt(l.shares) * 1_000_000n) / (total || 1n)) / 10_000;
        return (
          <div key={`${l.holder}|${l.label}`} className={`seg k-${kindOf(l)}`} style={{ flexBasis: `${share}%` }} title={`${who(l.holder)} · ${describe(l)}\n${shares(l.shares)} shares · ${share.toFixed(2)}%`}>
            {!thin && share > 7 ? <span>{who(l.holder)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ lines }: { lines: Line[] }) {
  const total = sum(lines);
  return (
    <table className="table legend">
      <thead><tr><th>Holder</th><th>Class</th><th className="num">Shares</th><th className="num">Owns</th></tr></thead>
      <tbody>
        {sortLines(lines).map((l) => (
          <tr key={`${l.holder}|${l.label}`}>
            <td><span className={`sw k-${kindOf(l)}`} aria-hidden="true" />{who(l.holder)}</td>
            <td className="muted">{describe(l)}</td>
            <td className="num mono">{shares(l.shares)}</td>
            <td className="num mono">{pct(BigInt(l.shares), total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td>Fully diluted</td><td /><td className="num mono">{shares(total)}</td><td className="num mono">100%</td></tr></tfoot>
    </table>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h1>{title}</h1>{children ? <p className="muted">{children}</p> : null}</div>;
}
