// Headless render check: serve dist/, load in Edge, screenshot the score area
// and dump the first page's SVG markup. Usage: node shot.mjs [outPng]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p));
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://localhost:${port}/`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const pane = document.getElementById("score-pane");
  const svgs = pane ? pane.querySelectorAll("svg") : [];
  const first = svgs[0];
  return {
    pages: svgs.length,
    firstViewBox: first?.getAttribute("viewBox") ?? null,
    firstChildren: first ? first.querySelectorAll("*").length : 0,
    paneText: pane ? pane.textContent.slice(0, 200) : "(no pane)",
    svgHead: first ? first.outerHTML.slice(0, 1200) : "(no svg)",
  };
});

console.log("pages:", info.pages);
console.log("firstViewBox:", info.firstViewBox);
console.log("firstChildren:", info.firstChildren);
console.log("paneText:", JSON.stringify(info.paneText));
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
console.log("--- first svg head ---\n" + info.svgHead);

const out = process.argv[2] ?? "/tmp/jpeditor-shot.png";
const pane = page.locator("#score-pane");
await pane.screenshot({ path: out }).catch(async () => {
  await page.screenshot({ path: out, fullPage: true });
});
console.log("screenshot:", out);

await browser.close();
server.close();
