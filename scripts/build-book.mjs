// Build a print-ready photobook (PDF) from a trip's project.json:
// cover + pages (mixed 1-or-2-photo layout) + captions. High-res images with
// baked orientation (Pillow via img-resize.py), sourced from export/_raw.
// Rendered with Chromium (Playwright) plus a resolution preflight report.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolveSlugFromArgs, tripPaths, readConfig, PYTHON } from "../trips-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const slug = resolveSlugFromArgs();
const tp = tripPaths(slug);
const cfg = readConfig(slug) || (() => { console.error("✖ config.json not found for " + slug); process.exit(1); })();
const RAW = tp.exportRaw;
const WEB = tp.web;
const THUMBS = tp.thumbs;
const BOOK = tp.book;
const ASSETS = path.join(BOOK, "assets");

// ---- page (from config) ----
const PAGE_W = cfg.book?.pageW || 210, PAGE_H = cfg.book?.pageH || 300; // mm (trim)
const SAFE = 15;                           // mm safe margin
const CONTENT_W = PAGE_W - 2 * SAFE;       // 180mm
const SHORT_CAPTION = 105;                 // up to this = "short" caption (fits 2 per page)
const DPI = 300;
const CONTENT_MAXPX = 2400;                // max px for page images
const COVER_MAXPX = 3600;

const die = (m) => { console.error("✖ " + m); process.exit(1); };
const readJSON = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fmtLong = (iso) => { if (!iso) return ""; const [, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

const rawSource = (uuid) => {
  for (const ext of ["jpeg", "jpg", "JPG", "JPEG", "png", "heic", "HEIC"]) {
    const p = path.join(RAW, `${uuid}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  if (fs.existsSync(path.join(WEB, `${uuid}.jpg`))) return path.join(WEB, `${uuid}.jpg`);
  if (fs.existsSync(path.join(THUMBS, `${uuid}.jpg`))) return path.join(THUMBS, `${uuid}.jpg`);
  return null;
};

const pyResize = (src, dest, maxdim) => new Promise((res) => {
  const c = spawn(PYTHON, [path.join(__dirname, "img-resize.py"), src, dest, String(maxdim)], { stdio: "ignore" });
  c.on("close", (code) => res(code === 0));
  c.on("error", () => res(false));
});

async function pool(items, worker, size) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; await worker(items[k], k); } }));
}

async function main() {
  const manifest = readJSON(tp.manifest);
  const project = readJSON(tp.project);
  if (!manifest || !project) die(`Missing manifest/project for ${slug} — build the catalog first.`);
  const byUuid = new Map(manifest.photos.map((p) => [p.uuid, p]));

  // sheet order — the printed book is photos only; any placed video is skipped.
  const items = [];
  let skippedVideos = 0;
  for (const sheet of project.album.sheets)
    for (const side of ["front", "back"])
      for (const u of sheet[side]) {
        const ph = u ? byUuid.get(u) : null;
        if (!ph) continue;
        if (ph.type === "video") { skippedVideos++; continue; }
        items.push({ uuid: u, caption: project.photos[u]?.caption || "", dayIndex: ph.dayIndex, w: ph.width, h: ph.height });
      }
  if (skippedVideos) console.log(`• Skipped ${skippedVideos} video(s) — the printed book is photos only.`);
  if (!items.length) die("No photos placed in the album.");

  const dayDate = (idx) => manifest.days.find((d) => d.index === idx)?.date || "";
  const cover = items.find((i) => i.w > i.h) || items[0];
  const start = manifest.trip.startDate;
  const lastDate = dayDate(Math.max(...items.map((i) => i.dayIndex)));
  const dateRange = `${fmtLong(start)} — ${fmtLong(lastDate)}, ${start.slice(0, 4)}`;
  const stats = { dias: new Set(items.map((i) => i.dayIndex)).size, fotos: items.length, legendas: items.filter((i) => i.caption.trim()).length };

  // --- layout: pair (same day + both captions short) otherwise solo ---
  const pages = [];
  let i = 0;
  while (i < items.length) {
    const a = items[i], b = items[i + 1];
    const aShort = a.caption.length <= SHORT_CAPTION;
    if (aShort && b && b.dayIndex === a.dayIndex && b.caption.length <= SHORT_CAPTION) {
      pages.push({ type: "two", items: [a, b] }); i += 2;
    } else { pages.push({ type: "one", items: [a] }); i += 1; }
  }

  // --- prepare images (baked orientation + resized) ---
  await fsp.mkdir(ASSETS, { recursive: true });
  const need = new Map(); // uuid -> maxpx
  need.set(cover.uuid, COVER_MAXPX);
  for (const it of items) if (!need.has(it.uuid)) need.set(it.uuid, CONTENT_MAXPX);

  console.log(`• Preparing high-res images (reusing existing)…`);
  let done = 0, missing = [];
  await pool([...need.entries()], async ([uuid, maxpx]) => {
    const dest = path.join(ASSETS, `${uuid}.jpg`);
    if (fs.existsSync(dest)) { done++; return; }
    const src = rawSource(uuid);
    if (!src) { missing.push(uuid); return; }
    await pyResize(src, dest, maxpx);
    if (++done % 40 === 0) console.log(`  … ${done}/${need.size}`);
  }, 6);

  // --- resolution preflight (uses native dimensions from the manifest) ---
  const neededPx = (mm) => Math.round((mm / 25.4) * DPI);
  const low = [];
  for (const pg of pages) {
    const boxLongMM = pg.type === "one" ? 185 : 130; // approximate usable height per photo
    for (const it of pg.items) {
      const nativeLong = Math.max(it.w, it.h);
      const req = neededPx(Math.max(CONTENT_W, boxLongMM));
      if (nativeLong && nativeLong < req) low.push({ uuid: it.uuid, native: nativeLong, req, dpi: Math.round(nativeLong / (Math.max(CONTENT_W, boxLongMM) / 25.4)) });
    }
  }

  // --- HTML ---
  const asset = (uuid) => `assets/${uuid}.jpg`;
  const IMG_H = { one: 202, two: 88 }; // max image height per page type (mm)
  // DISPLAYED image width = min(usable width, maxHeight × aspect). Fix the unit
  // at that width → the caption exactly matches the frame.
  const slot = (it, type) => {
    const aspect = it.w && it.h ? it.w / it.h : 1;
    const dispW = Math.min(CONTENT_W, IMG_H[type] * aspect);
    return `
    <div class="slot">
      <figure class="unit" style="width:${dispW.toFixed(1)}mm">
        <img src="${asset(it.uuid)}" />
        ${it.caption.trim() ? `<figcaption>${esc(it.caption)}</figcaption>` : ""}
      </figure>
    </div>`;
  };

  const contentPages = pages.map((pg) => {
    const day = pg.items[0].dayIndex;
    const tag = `Day ${day} · ${fmtLong(dayDate(day))}`;
    return `<section class="page ${pg.type}">
      <div class="content">
        <div class="daytag">${esc(tag)}</div>
        ${pg.items.map((it) => slot(it, pg.type)).join("")}
      </div>
    </section>`;
  }).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<style>
  @import url("https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..600;1,9..144,400..600&family=Hanken+Grotesk:wght@400;600;700&display=swap");
  @page { size: ${PAGE_W}mm ${PAGE_H}mm; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { font-family: "Hanken Grotesk", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: ${PAGE_W}mm; height: ${PAGE_H}mm; position: relative; overflow: hidden; background: #fbf6ea; page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  /* cover */
  .cover img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .cover .veil { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 42%, rgba(8,18,55,0.35), rgba(6,13,42,0.86)); }
  .cover .c-in { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #fff; padding: 24mm; }
  .kicker { font-size: 11pt; letter-spacing: 6pt; text-transform: uppercase; color: #f4d488; font-weight: 700; margin-bottom: 8mm; }
  .title { font-family: "Fraunces", serif; font-weight: 600; font-size: 46pt; line-height: 1.02; }
  .drange { font-family: "Fraunces", serif; font-style: italic; font-size: 17pt; margin-top: 8mm; color: #dbe6ff; }
  .cstats { display: flex; gap: 16mm; margin-top: 12mm; }
  .cstats b { font-family: "Fraunces", serif; font-size: 26pt; color: #f4d488; display: block; }
  .cstats span { font-size: 8pt; letter-spacing: 1.5pt; text-transform: uppercase; color: #9fb0e0; }

  /* content pages */
  .content { position: absolute; inset: 0; padding: ${SAFE}mm; display: flex; flex-direction: column; gap: 6mm; }
  .daytag { font-family: "Fraunces", serif; font-weight: 600; color: #1e4fd6; font-size: 10pt; letter-spacing: 1pt; text-transform: uppercase; flex: none; }
  .slot { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  /* .unit has fixed width = displayed image width → caption aligned to the frame */
  .unit { display: flex; flex-direction: column; align-items: center; max-width: 100%; max-height: 100%; }
  .unit img { max-width: 100%; width: auto; height: auto; display: block; border-radius: 1mm; box-shadow: 0 2mm 6mm rgba(20,40,90,0.18); }
  .unit figcaption { width: 100%; margin-top: 5mm; text-align: center; font-family: "Fraunces", serif; font-style: italic; line-height: 1.42; color: #2a3557; overflow-wrap: break-word; }
  .one .unit img { max-height: 202mm; }
  .one .unit figcaption { font-size: 12.5pt; }
  .two .unit img { max-height: 88mm; }
  .two .unit figcaption { font-size: 11pt; }

  /* closing */
  .end { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .end .star { font-size: 26pt; color: #e9b84d; }
  .end h2 { font-family: "Fraunces", serif; font-weight: 600; font-size: 30pt; color: #1a2649; margin: 6mm 0 3mm; }
  .end p { color: #5a6690; font-size: 13pt; }
  .end .castle { font-size: 40pt; margin-top: 8mm; }
</style></head><body>
  <section class="page cover">
    <img class="bg" src="${asset(cover.uuid)}" />
    <div class="veil"></div>
    <div class="c-in">
      ${cfg.kicker ? `<div class="kicker">${esc(cfg.kicker)}</div>` : ""}
      <div class="title">${esc(cfg.title)}</div>
      <div class="drange">${esc(dateRange)}</div>
      <div class="cstats">
        <div><b>${stats.dias}</b><span>days</span></div>
        <div><b>${stats.fotos}</b><span>moments</span></div>
        <div><b>${stats.legendas}</b><span>stories</span></div>
      </div>
    </div>
  </section>
  ${contentPages}
  <section class="page end"><div class="content" style="align-items:center;justify-content:center">
    <div class="star">✦</div>
    <h2>${stats.dias} magical days.</h2>
    <p>${stats.fotos} memories to keep forever.</p>
    <div class="castle">🏰</div>
  </div></section>
</body></html>`;

  await fsp.writeFile(path.join(BOOK, "index.html"), html);

  // --- render PDF ---
  console.log("• Renderizando PDF…");
  const browser = await chromium.launch({ channel: "chrome", args: ["--allow-file-access-from-files"] });
  const page = await browser.newPage();
  await page.goto("file://" + path.join(BOOK, "index.html"), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const pdfPath = path.join(BOOK, "album.pdf");
  await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  await browser.close();

  // --- preflight report ---
  const lines = [];
  lines.push(`Fotolivro ${cfg.title} [${slug}] — preflight`);
  lines.push(`Size: ${PAGE_W}×${PAGE_H} mm · ${pages.length + 2} pages (cover + ${pages.length} + closing)`);
  lines.push(`Photos: ${items.length} (${pages.filter(p => p.type === "two").length} pages with 2 photos, ${pages.filter(p => p.type === "one").length} with 1)`);
  if (missing.length) lines.push(`\n⚠ ${missing.length} missing from export/_raw (run Export): ${missing.slice(0, 8).join(", ")}`);
  if (low.length) {
    lines.push(`\n⚠ ${low.length} photo(s) below ${DPI} DPI at print size:`);
    for (const l of low.slice(0, 20)) lines.push(`   ${l.uuid}  ~${l.dpi} DPI (nativo ${l.native}px, precisa ${l.req}px)`);
  } else lines.push(`\n✓ All photos are ≥ ${DPI} DPI at print size.`);
  const report = lines.join("\n");
  await fsp.writeFile(path.join(BOOK, "preflight.txt"), report + "\n");

  console.log("\n" + report);
  console.log(`\n✓ PDF: book/album.pdf`);
}

main().catch((e) => die(e.stack || String(e)));
