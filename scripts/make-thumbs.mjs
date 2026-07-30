// Generate <trip>/thumbs/{uuid}.jpg from local Photos-library previews
// (path_derivatives in <trip>/photos.json) and write <trip>/manifest.json.
// RUN IN YOUR TERMINAL (Full Disk Access). Usage: node scripts/make-thumbs.mjs <slug>
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSlugFromArgs, tripPaths, readConfig, photoMeta } from "../trips-lib.mjs";

const MAX_DIM = 1600;
const CONCURRENCY = 8;
const die = (m) => { console.error("✖ " + m); process.exit(1); };

const slug = resolveSlugFromArgs();
const tp = tripPaths(slug);
const cfg = readConfig(slug) || die("config.json not found for " + slug);
const trip = { startDate: cfg.startDate, days: cfg.days };
if (!fs.existsSync(tp.photos)) die(`Missing ${slug}/photos.json — run the osxphotos query first.`);

const parsePhotos = () => {
  const t = fs.readFileSync(tp.photos, "utf8").replace(/\bNaN\b/g, "null").replace(/-?\bInfinity\b/g, "null");
  const raw = JSON.parse(t);
  return Array.isArray(raw) ? raw : raw?.photos ?? [];
};

const startMs = Date.parse(trip.startDate + "T00:00:00");
const dayIndexFor = (iso) => {
  const ms = Date.parse((iso || "").slice(0, 10) + "T00:00:00");
  if (Number.isNaN(ms)) return 1;
  return Math.min(Math.max(Math.round((ms - startMs) / 86400000) + 1, 1), trip.days);
};
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
const dupSig = (p) =>
  p.fingerprint || p.cloud_guid ||
  (p.original_filesize ? `${p.original_filesize}-${p.original_width || p.width}-${p.original_height || p.height}` : p.uuid);

const sips = (args) => new Promise((res) => {
  const c = spawn("sips", args, { stdio: "ignore" });
  c.on("close", (code) => res(code === 0));
  c.on("error", () => res(false));
});
const makeThumb = async (uuid, candidates) => {
  const dest = path.join(tp.thumbs, `${uuid}.jpg`);
  const tmp = path.join(tp.thumbs, `.tmp-${uuid}.jpg`);
  for (const src of candidates) {
    if (!src || !fs.existsSync(src)) continue;
    if (await sips(["-Z", String(MAX_DIM), "-s", "format", "jpeg", src, "--out", tmp]) && fs.existsSync(tmp)) {
      await fsp.rename(tmp, dest); return true;
    }
    try { await fsp.unlink(tmp); } catch {}
  }
  return false;
};
async function pool(items, worker, size) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); } }));
  return out;
}

async function main() {
  await fsp.mkdir(tp.thumbs, { recursive: true });
  const photos = parsePhotos().filter((p) => !p.ismovie);
  if (!photos.length) die("0 photos in photos.json.");
  console.log(`• [${slug}] Generating thumbnails for ${photos.length} photos…`);
  // live progress for the UI (polled by the server); removed when done
  const progressFile = path.join(tp.thumbs, ".progress.json");
  const writeProgress = (d) => { try { fs.writeFileSync(progressFile, JSON.stringify({ done: d, total: photos.length })); } catch {} };
  writeProgress(0);
  let done = 0, ok = 0;
  const out = await pool(photos, async (p) => {
    const uuid = p.uuid;
    const dest = path.join(tp.thumbs, `${uuid}.jpg`);
    let hasThumb = fs.existsSync(dest);
    if (!hasThumb) {
      const ders = (p.path_derivatives || []).slice().sort((a, b) => sizeOf(b) - sizeOf(a));
      hasThumb = await makeThumb(uuid, [...ders, p.path_edited, p.path]);
    }
    if (hasThumb) ok++;
    done++; writeProgress(done);
    if (done % 200 === 0) console.log(`  … ${done}/${photos.length}`);
    const localDate = p.date_original || p.date || "";
    return {
      uuid, filename: p.original_filename || p.filename || uuid, date: localDate, dayIndex: dayIndexFor(localDate),
      width: p.width || p.original_width || 0, height: p.height || p.original_height || 0,
      isFavorite: !!p.favorite, hasThumb, sig: dupSig(p), meta: photoMeta(p),
    };
  }, CONCURRENCY);

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const days = Array.from({ length: trip.days }, (_, i) => {
    const date = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    return { index: i + 1, date, label: `Day ${i + 1}`, count: out.filter((p) => p.dayIndex === i + 1).length };
  });
  await fsp.writeFile(tp.manifest, JSON.stringify({ generatedAt: new Date().toISOString(), trip, days, photos: out }));
  try { fs.rmSync(progressFile); } catch {}
  console.log(`\n✓ [${slug}] ${ok}/${photos.length} thumbnails. manifest.json ready.`);
  for (const d of days) console.log(`   ${d.label} (${d.date}): ${d.count}`);
}
main().catch((e) => die(e.stack || String(e)));
