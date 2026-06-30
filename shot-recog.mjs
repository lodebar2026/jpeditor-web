// 识别模式无头校验：serve dist/，加载后用 window.__app.recognizeBytes 跑真实 OMR，
// 验证自动进入识别模式、二值图 image + 叠加层渲染，截图。
// 用法: node shot-recog.mjs [outPng] [imgPath]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".onnx": "application/octet-stream",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/recog-shot.png";
const img = process.argv[3] || "testdata/日光之下/日光之下简谱.jpg";
const imgBytes = [...await readFile(img)];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const result = await page.evaluate(async (bytes) => {
  const app = window.__app;
  await app.recognizeBytes("musicpp", { bytes: new Uint8Array(bytes), mime: "image/jpeg", path: null });
  const pane = document.getElementById("score-pane");
  const svg = pane.querySelector("svg.omr-recognize");
  return {
    mode: app.mode,
    bodyHasRecognize: document.getElementById("body").classList.contains("recognize"),
    recognizeBtnDisabled: document.getElementById("btn-recognize").disabled,
    recognizeBtnText: document.getElementById("btn-recognize").textContent,
    overlaySvgPresent: !!svg,
    viewBox: svg?.getAttribute("viewBox"),
    bgImage: !!svg?.querySelector("image"),
    overlayTexts: svg?.querySelectorAll(".omr-overlay text").length ?? 0,
    overlayBarlines: svg?.querySelectorAll(".omr-overlay .omr-barline").length ?? 0,
    overlayMarks: svg?.querySelectorAll(".omr-overlay .omr-mark").length ?? 0,
    editorPresent: !!document.querySelector(".cm-content"),
  };
}, imgBytes);
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.filter(e => !/favicon/.test(e)).join("\n"));
await page.screenshot({ path: out, fullPage: false });
console.log("screenshot:", out);
await browser.close();
server.close();
