// 批量实测 musicpp 本地 OMR 准确率：遍历 testdata/ 下每个歌谱文件夹（各含一张图片 + 一份 .jpwabc GT），
// 用 Edge 跑真实 src/omr 管线（recognizeJianpu → toMusicXml → 编辑器导入 → getText），
// 与 GT 同一 tokenizer 出 token，算 Levenshtein 准确率。用法：
//   node measure-all.mjs              # 全部歌谱
//   node measure-all.mjs 世上 日光    # 仅文件夹名含这些子串的
// 需先 npm run build 出 dist + 本地 Edge。
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize, basename } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const TESTDATA = join(process.cwd(), "testdata");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".bmp": "image/bmp", ".webp": "image/webp" };
const filters = process.argv.slice(2);

function decodeJpwabc(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(buf.slice(2)).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) { const s = Buffer.from(buf.slice(2)); s.swap16(); return s.toString("utf16le"); }
  return buf.toString("utf8");
}

// 逐音符粘性 token。jpwabc 音符间可无空格；下划线(_)与附点(.)顺序不固定(GT 自身混用 6,_./2._)，
// 故用 [_.]* 一并吞、各自计数。一个音 → N<digit>o<octave>u<下划线数>(+附点)，增时线 '-' 单列、小节线 '|'。
function voiceTokens(text) {
  const lines = text.split(/\r?\n/); let inV = false; const toks = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); continue; }
    if (!inV || !t) continue;
    const s = ln.replace(/\$\([^)]*\)/g, " ");
    const re = /([0-7])([',]*)([_.]*)(-*)|(\|)|(-)/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[5]) { toks.push("|"); continue; }
      if (m[6]) { toks.push("-"); continue; }
      const oct = m[2].split("").reduce((a, c) => a + (c === "'" ? 1 : -1), 0);
      const u = (m[3].match(/_/g) || []).length;
      const dot = (m[3].match(/\./g) || []).length ? "." : "";
      toks.push(`N${m[1]}o${oct}u${u}${dot}`);
      for (let i = 0; i < m[4].length; i++) toks.push("-");
    }
  }
  return toks;
}

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur; }
  return prev[n];
}
const acc = (g, r) => 1 - lev(g, r) / Math.max(g.length, r.length, 1);
// 去掉八度/下划线/附点 → 仅"数字+小节线+增时线"
const dOnly = (t) => t.map((x) => (x === "|" || x === "-" ? x : x.replace(/o.*$/, "")));
// 去掉下划线/附点(留八度) → "数字+八度+小节线"
const dOct = (t) => t.map((x) => (x === "|" || x === "-" ? x : x.replace(/u\d+\.?$/, "")));

async function findSongs() {
  const out = [];
  for (const name of (await readdir(TESTDATA, { withFileTypes: true })).filter((d) => d.isDirectory())) {
    const dir = join(TESTDATA, name.name);
    const files = await readdir(dir);
    const img = files.find((f) => IMG_EXT.has(extname(f).toLowerCase()));
    const gt = files.find((f) => extname(f).toLowerCase() === ".jpwabc");
    if (!img || !gt) continue;
    if (filters.length && !filters.some((f) => name.name.includes(f))) continue;
    out.push({ name: name.name, img: join(dir, img), gt: join(dir, gt) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

const server = createServer(async (req, res) => {
  try { let p = decodeURIComponent((req.url ?? "/").split("?")[0]); if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const songs = await findSongs();
if (!songs.length) { console.log("testdata/ 下没找到 图片+jpwabc 的歌谱文件夹"); await browser.close(); server.close(); process.exit(0); }

const rows = [];
let sumA = 0, sumD = 0, sumO = 0;
for (const song of songs) {
  errors.length = 0;
  const mime = MIME[extname(song.img).toLowerCase()] ?? "image/jpeg";
  const b64 = Buffer.from(await readFile(song.img)).toString("base64");
  let rec;
  try {
    rec = await page.evaluate(async ({ b64, mime }) => {
      const omr = await window.__omr;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bin = await omr.decodeToBinary(bytes, mime);
      const score = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
      const stats = { rows: score.rows.length, notes: score.rows.reduce((a, r) => a + r.nums.length, 0), bars: score.rows.reduce((a, r) => a + r.barlineXs.length, 0) };
      window.__app.importBytes(new TextEncoder().encode(omr.toMusicXml(score)), "omr.musicxml");
      return { jpw: window.__app.getText(), stats };
    }, { b64, mime });
  } catch (e) {
    console.log(`✗ ${song.name}: 识别异常 ${String(e).slice(0, 120)}`);
    rows.push({ name: song.name, a: 0, d: 0, o: 0, g: 0, r: 0, stats: {} });
    continue;
  }
  const g = voiceTokens(decodeJpwabc(await readFile(song.gt)));
  const r = voiceTokens(rec.jpw);
  const a = acc(g, r), d = acc(dOnly(g), dOnly(r)), o = acc(dOct(g), dOct(r));
  sumA += a; sumD += d; sumO += o;
  rows.push({ name: song.name, a, d, o, g: g.length, r: r.length, stats: rec.stats, err: errors.filter((e) => !/favicon|space too large/.test(e)).slice(0, 2) });
}

const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
console.log("\n歌谱".padEnd(20) + "  完整   数字+八度  数字+小节   GT/识别   结构(行/音/线)");
console.log("─".repeat(86));
for (const x of rows) {
  console.log(
    x.name.padEnd(20) + "  " + pct(x.a) + "   " + pct(x.o) + "    " + pct(x.d) +
    "   " + `${x.g}/${x.r}`.padStart(8) + "   " +
    (x.stats.rows !== undefined ? `${x.stats.rows}/${x.stats.notes}/${x.stats.bars}` : "-"));
  if (x.err?.length) console.log("    ⚠ " + x.err.join(" | ").slice(0, 100));
}
console.log("─".repeat(86));
const n = rows.length;
console.log("平均".padEnd(20) + "  " + pct(sumA / n) + "   " + pct(sumO / n) + "    " + pct(sumD / n) + `   (${n} 首)`);

await browser.close();
server.close();
