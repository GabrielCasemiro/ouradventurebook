// Generate high-res <trip>/web/{uuid}.jpg (2560px, baked orientation) only for photos used
// in the album. Source: originals in export/_raw (no FDA); otherwise local previews (FDA).
// Usage: node scripts/make-web.mjs <slug>
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSlugFromArgs, tripPaths, readJSON, PYTHON } from "../trips-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_DIM = 2560;
const CONCURRENCY = 6;
const die = (m) => { console.error("✖ " + m); process.exit(1); };

const slug = resolveSlugFromArgs();
const tp = tripPaths(slug);
const project = readJSON(tp.project) || die("Sem project.json para " + slug);
if (!fs.existsSync(tp.photos)) die("Sem photos.json para " + slug);

const parsePhotos = () => {
  const t = fs.readFileSync(tp.photos, "utf8").replace(/\bNaN\b/g, "null").replace(/-?\bInfinity\b/g, "null");
  const raw = JSON.parse(t);
  return Array.isArray(raw) ? raw : raw?.photos ?? [];
};

const used = new Set();
for (const s of project.album.sheets) for (const sd of ["front", "back"]) for (const u of s[sd]) if (u) used.add(u);
for (const [u, v] of Object.entries(project.photos || {})) if (v?.chosen) used.add(u);

const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
const rawSource = (uuid) => {
  for (const ext of ["jpeg", "jpg", "JPG", "JPEG", "png", "heic", "HEIC"]) {
    const p = path.join(tp.exportRaw, `${uuid}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
};
const pyResize = (src, dest) => new Promise((res) => {
  const c = spawn(PYTHON, [path.join(__dirname, "img-resize.py"), src, dest, String(MAX_DIM)], { stdio: "ignore" });
  c.on("close", (code) => res(code === 0));
  c.on("error", () => res(false));
});
const make = async (uuid, candidates) => {
  const dest = path.join(tp.web, `${uuid}.jpg`);
  const tmp = path.join(tp.web, `.tmp-${uuid}.jpg`);
  for (const src of candidates) {
    if (!src || !fs.existsSync(src)) continue;
    if (await pyResize(src, tmp) && fs.existsSync(tmp)) {
      await fsp.rename(tmp, dest);
      return src.startsWith(tp.exportRaw) ? "original" : "preview";
    }
    try { await fsp.unlink(tmp); } catch {}
  }
  return null;
};
async function pool(items, worker, size) {
  let i = 0; await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; await worker(items[k], k); } }));
}

async function main() {
  await fsp.mkdir(tp.web, { recursive: true });
  const byUuid = new Map(parsePhotos().map((p) => [p.uuid, p]));
  const list = [...used];
  if (!list.length) die("No photos chosen/placed yet.");
  // remember which source each render came from, so a render made from a local
  // preview can be upgraded to the true original once it's been downloaded.
  const sidecar = path.join(tp.web, ".sources.json");
  const sources = readJSON(sidecar) || {};
  // live progress for the UI (polled by the server); removed when done
  const progressFile = path.join(tp.web, ".progress.json");
  const writeProgress = (done) => { try { fs.writeFileSync(progressFile, JSON.stringify({ done, total: list.length })); } catch {} };
  writeProgress(0);
  console.log(`• [${slug}] Preparing web images @${MAX_DIM}px for ${list.length} photos…`);
  let done = 0, ori = 0, prev = 0, fail = 0, upgraded = 0, kept = 0;
  await pool(list, async (uuid) => {
    const dest = path.join(tp.web, `${uuid}.jpg`);
    const exists = fs.existsSync(dest);
    const hasOriginal = !!rawSource(uuid);
    // keep what we have if it's already the original, or if nothing better exists locally yet
    if (exists && (sources[uuid] === "original" || !hasOriginal)) { kept++; writeProgress(++done); return; }
    const p = byUuid.get(uuid);
    const ders = (p?.path_derivatives || []).slice().sort((a, b) => sizeOf(b) - sizeOf(a));
    const wasPreview = exists && sources[uuid] !== "original";
    const r = await make(uuid, [rawSource(uuid), ...ders, p?.path_edited, p?.path]);
    if (r) { sources[uuid] = r; if (r === "original") { ori++; if (wasPreview) upgraded++; } else prev++; }
    else fail++;
    writeProgress(++done);
    if (done % 50 === 0) console.log(`  … ${done}/${list.length}`);
  }, CONCURRENCY);
  await fsp.writeFile(sidecar, JSON.stringify(sources));
  try { fs.rmSync(progressFile); } catch {}
  console.log(`\n✓ [${slug}] ${ori + prev} rendered (${ori} from originals, ${prev} from preview), ${upgraded} upgraded, ${kept} unchanged.`);
  if (fail) console.log(`  ⚠ ${fail} failed (no source).`);
  const soft = list.filter((u) => sources[u] && sources[u] !== "original").length;
  if (soft) console.log(`  ℹ ${soft} photos are from local previews — run Export to download originals for full HD.`);
}
main().catch((e) => die(e.stack || String(e)));
