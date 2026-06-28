// 验证歌词逐音节对齐：跑 paddle 管线 → import → getText，提取 .Words 与 GT 比对(按 verse 汉字 CER)。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const IMG = "testdata/日光之下/日光之下简谱.jpg";
const GT = "testdata/日光之下/日光之下.jpwabc";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

function dec(b){ if(b[0]===0xff&&b[1]===0xfe)return Buffer.from(b.slice(2)).toString("utf16le"); if(b[0]===0xfe&&b[1]===0xff){const s=Buffer.from(b.slice(2));s.swap16();return s.toString("utf16le");} return b.toString("utf8"); }
const hanzi = (s) => (s.match(/[一-鿿]/g) || []).join("");
function lev(a,b){const m=a.length,n=b.length;if(!m)return n;if(!n)return m;let p=[...Array(n+1).keys()];for(let i=1;i<=m;i++){const c=[i];for(let j=1;j<=n;j++)c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c;}return p[n];}

// GT .Words 的 W1/W2 → 各自全部汉字
const gtText = dec(await readFile(GT));
function verse(tag){ const lines=gtText.split(/\r?\n/); let on=false; let s=""; for(const ln of lines){ if(ln.startsWith(tag)){on=true;continue;} if(on){ if(/^[A-Z]\d+@/.test(ln)||ln.startsWith(".")) break; s+=ln; } } return hanzi(s); }
const gtW1 = verse("W1@"), gtW2 = verse("W2@");

const server = createServer(async (req,res)=>{ try{ let p=decodeURIComponent((req.url??"/").split("?")[0]); if(p==="/")p="/index.html"; const d=await readFile(join(ROOT,normalize(p))); res.writeHead(200,{"content-type":MIME[extname(p)]??"application/octet-stream"}); res.end(d);}catch{res.writeHead(404);res.end("nf");}});
await new Promise(r=>server.listen(0,r));
const port=server.address().port;
const browser=await chromium.launch({channel:"msedge",headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; page.on("console",m=>{if(m.type()==="error")errs.push(m.text());}); page.on("pageerror",e=>errs.push("pe:"+e.message));
await page.goto(`http://localhost:${port}/`,{waitUntil:"networkidle"}); await page.waitForTimeout(500);

const jpgB64=Buffer.from(await readFile(IMG)).toString("base64");
const jpw = await page.evaluate(async ({b64})=>{
  const omr=await window.__omr;
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  const bin=await omr.decodeToBinary(bytes,"image/jpeg");
  const score=await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
  const xml=omr.toMusicXml(score);
  window.__app.importBytes(new TextEncoder().encode(xml),"omr.musicxml");
  return window.__app.getText();
},{b64:jpgB64});

// 提取生成 jpw 的 .Words
const lines = jpw.split(/\r?\n/); let inW=false; let wbuf=[];
for(const ln of lines){ const t=ln.trim(); if(t.startsWith(".")){inW=/^\.words/i.test(t);continue;} if(inW)wbuf.push(ln); }
const genWords = wbuf.join("\n");
const genVerses = {};
{ let cur=null; for(const ln of wbuf){ const m=ln.match(/^(W\d+)@/); if(m){cur=m[1];genVerses[cur]="";continue;} if(cur)genVerses[cur]+=ln; } }
const genW1 = hanzi(genVerses.W1||""), genW2 = hanzi(genVerses.W2||"");

console.log("=== 生成的 .Words（前 400 字符）===");
console.log(genWords.slice(0,400));
console.log("\n=== verse 对比（汉字 CER）===");
for(const [name,gt,gen] of [["W1",gtW1,genW1],["W2",gtW2,genW2]]){
  const e=lev([...gt],[...gen]); const acc=1-e/Math.max(gt.length,gen.length,1);
  console.log(`${name}: GT ${gt.length} 字 / 生成 ${gen.length} 字 / 编辑距离 ${e} / 准确率 ${(acc*100).toFixed(1)}%`);
  console.log(`  GT : ${gt.slice(0,40)}`);
  console.log(`  生成: ${gen.slice(0,40)}`);
}
if(errs.length) console.log("ERRORS:",errs.filter(e=>!/favicon|title count/.test(e)).slice(0,3).join(" | "));
await browser.close(); server.close();
