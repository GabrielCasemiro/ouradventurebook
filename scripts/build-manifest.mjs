// Rebuild a trip's manifest.json from photos.json + existing thumbnails
// (checks which {uuid}.jpg exist). Does not generate thumbnails and needs no FDA.
// Usage: node scripts/build-manifest.mjs <slug>
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSlugFromArgs, tripPaths, readConfig } from "../trips-lib.mjs";

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

async function main() {
  const photos = parsePhotos().filter((p) => !p.ismovie);
  if (!photos.length) die("0 photos in photos.json.");
  const out = photos.map((p) => {
    const localDate = p.date_original || p.date || "";
    return {
      uuid: p.uuid,
      filename: p.original_filename || p.filename || p.uuid,
      date: localDate,
      dayIndex: dayIndexFor(localDate),
      width: p.width || p.original_width || 0,
      height: p.height || p.original_height || 0,
      isFavorite: !!p.favorite,
      hasThumb: fs.existsSync(path.join(tp.thumbs, `${p.uuid}.jpg`)),
      sig:
        p.fingerprint ||
        p.cloud_guid ||
        (p.original_filesize ? `${p.original_filesize}-${p.original_width || p.width}-${p.original_height || p.height}` : p.uuid),
    };
  });
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const days = Array.from({ length: trip.days }, (_, i) => {
    const date = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    return { index: i + 1, date, label: `Day ${i + 1}`, count: out.filter((p) => p.dayIndex === i + 1).length };
  });
  await fsp.writeFile(tp.manifest, JSON.stringify({ generatedAt: new Date().toISOString(), trip, days, photos: out }));
  const withThumb = out.filter((p) => p.hasThumb).length;
  console.log(`✓ [${slug}] manifest.json: ${out.length} photos, ${withThumb} with thumbnail.`);
}
main().catch((e) => die(e.stack || String(e)));
