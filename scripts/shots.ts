// Screenshots of the built page (web/dist) in headless Chromium: desktop and phone, live from testnet and with
// testnet blocked (the recorded snapshot). Also checks the page has no horizontal scroll and no console errors.
//   npm run build:web && npm run shots        writes docs/shots/*.png
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "web/dist");
const OUT = join(ROOT, "docs/shots");
mkdirSync(OUT, { recursive: true });
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const path = join(DIST, decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\/$/, "/index.html"));
  if (!path.startsWith(DIST) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(0);
const port = (server.address() as any).port;
const browser = await chromium.launch();
let fails = 0;
const cases = [
  { name: "desktop-live", viewport: { width: 1280, height: 900 }, block: false },
  { name: "phone-live", viewport: { width: 390, height: 844 }, block: false },
  { name: "desktop-snapshot", viewport: { width: 1280, height: 900 }, block: true },
  { name: "phone-snapshot", viewport: { width: 390, height: 844 }, block: true },
];
for (const c of cases) {
  const page = await browser.newPage({ viewport: c.viewport, deviceScaleFactor: c.name.startsWith("phone") ? 2 : 1 });
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  if (c.block) await page.route(/rpc|drpc/, (r) => r.abort());
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector("body[data-ready]", { timeout: 60_000 });
  await page.waitForTimeout(1200);
  const mode = await page.getAttribute("body", "data-ready");
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const ok = mode === (c.block ? "snapshot" : "live") && scroll <= 0 && errors.length === 0;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}: mode ${mode}, horizontal overflow ${scroll}px, ${errors.length} console errors${errors.length ? `: ${errors.join(" | ").slice(0, 200)}` : ""}`);
  await page.screenshot({ path: join(OUT, `${c.name}.png`), fullPage: true });
  if (c.name === "desktop-live") {
    // Move the sliders: the model and the waterfall redraw from the contract's views.
    await page.locator("#i-pre").fill("300");
    await page.locator("#i-exit").fill("900");
    await page.waitForTimeout(2500);
    await page.locator("#model").screenshot({ path: join(OUT, "model-low-pre.png") });
    await page.locator("#exit").screenshot({ path: join(OUT, "exit-high.png") });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(fails ? `${fails} FAILED` : "page checks passed");
process.exit(fails ? 1 : 0);
