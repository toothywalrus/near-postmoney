import { useEffect, useState } from "react";
import { accountUrl, BOARD, COMPANY, USDC } from "../../src/chain.ts";
import { useData } from "./data.ts";
import { Board } from "./pages/Board.tsx";
import { Model } from "./pages/Model.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Safes } from "./pages/Safes.tsx";
import { setTheme, useTheme } from "./theme.ts";
import { Empty, Icon, Mark } from "./ui.tsx";

function useRoute(): string {
  const read = () => (location.hash || "#/").replace(/^#\/?/, "").split("/")[0] ?? "";
  const [r, setR] = useState(read);
  useEffect(() => {
    const f = () => { setR(read()); window.scrollTo(0, 0); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return r;
}

const NAV = [
  { key: "", label: "Overview" },
  { key: "model", label: "Model a round" },
  { key: "safes", label: "SAFEs" },
  { key: "board", label: "Board" },
];

export function App() {
  const d = useData();
  const page = useRoute();
  const theme = useTheme();
  let body;
  if (!d) body = <div className="loading" role="status"><span className="spinner" aria-hidden="true" />Reading the cap table from NEAR testnet…</div>;
  else if (page === "") body = <Overview d={d} />;
  else if (page === "model") body = <Model d={d} />;
  else if (page === "safes") body = <Safes d={d} />;
  else if (page === "board") body = <Board d={d} />;
  else body = <Empty title="Page not found"><a href="#/">Back to the overview</a></Empty>;

  return (
    <div className="shell">
      <header className="top">
        <div className="top-in">
          <a className="brand" href="#/" aria-label="Postmoney overview"><Mark /><span>Postmoney</span></a>
          <nav className="nav" aria-label="Pages">
            {NAV.map((n) => <a key={n.key} href={`#/${n.key}`} className={page === n.key ? "on" : ""} aria-current={page === n.key ? "page" : undefined}>{n.label}</a>)}
          </nav>
          <div className="top-right">
            {d ? (
              <span className={`live ${d.live ? "on" : "off"}`} title={d.live ? "Every number on this page is read from the contracts on NEAR testnet" : "Testnet didn't answer; showing a recorded snapshot"}>
                <span className="live-dot" aria-hidden="true" />{d.live ? <>Live · block {d.S.block?.toLocaleString("en-US")}</> : "Snapshot"}
              </span>
            ) : null}
            <button className="btn icon ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Switch theme">
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
          </div>
        </div>
      </header>
      {d && !d.live ? (
        <div className="banner warn"><div className="banner-in"><Icon name="alert" size={14} />Testnet didn't answer, so this is the snapshot recorded {new Date(d.S.recorded_at!).toUTCString().slice(5, 22)} UTC. Models run in your browser with the reference implementation.</div></div>
      ) : null}
      <main className="main">{body}</main>
      <footer className="foot">
        <span>Acme Robotics is a made-up company; tUSDC-TEST has no value. Built at NEAR HACKATHON.</span>
        <span>
          <a href={accountUrl(COMPANY)} target="_blank" rel="noreferrer">Cap table</a> · <a href={accountUrl(BOARD)} target="_blank" rel="noreferrer">Board</a> ·{" "}
          <a href={accountUrl(USDC)} target="_blank" rel="noreferrer">Token</a> · <a href="../">Previous design</a>
        </span>
      </footer>
    </div>
  );
}
