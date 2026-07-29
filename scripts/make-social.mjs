// Render social carousels to trips/<slug>/social/<carousel>/NN.jpg + caption.txt.
// Each slide fits the whole photo (no crop) onto the carousel's format canvas.
// Source: the HD web render if present, otherwise the exported original, otherwise the thumb.
// Usage: node scripts/make-social.mjs <slug> [carouselId]
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, resolveSlugFromArgs, tripPaths, readJSON, PYTHON } from "../trips-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error("✖ " + m); process.exit(1); };

const argv = process.argv.slice(2);
const slug = resolveSlugFromArgs();
const onlyId = argv.find((a) => a !== slug && !a.startsWith("-"));
const tp = tripPaths(slug);

const FORMATS = { "4x5": [1080, 1350], "1x1": [1080, 1080], "9x16": [1080, 1920] };

const social = readJSON(tp.social) || { carousels: [] };
let carousels = social.carousels || [];
if (onlyId) carousels = carousels.filter((c) => c.id === onlyId);
if (!carousels.length) die(onlyId ? `Carousel ${onlyId} not found.` : "No carousels to render.");

const rawSource = (uuid) => {
  for (const ext of ["jpeg", "jpg", "JPG", "JPEG", "png", "heic", "HEIC"]) {
    const p = path.join(tp.exportRaw, `${uuid}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
};
const source = (uuid) => {
  const web = path.join(tp.web, `${uuid}.jpg`);
  if (fs.existsSync(web)) return web;
  const raw = rawSource(uuid);
  if (raw) return raw;
  const thumb = path.join(tp.thumbs, `${uuid}.jpg`);
  return fs.existsSync(thumb) ? thumb : null;
};

const compose = (src, dest, w, h, bg) => new Promise((res) => {
  const c = spawn(PYTHON, [path.join(__dirname, "social-canvas.py"), src, dest, String(w), String(h), bg], { stdio: "ignore" });
  c.on("close", (code) => res(code === 0));
  c.on("error", () => res(false));
});

// filesystem-safe folder name for a carousel
const folderName = (c, i) => {
  const base = (c.title || `carousel-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${String(i + 1).padStart(2, "0")}-${base || "carousel"}`;
};

async function main() {
  await fsp.mkdir(tp.socialDir, { recursive: true });
  const progress = path.join(tp.socialDir, ".progress.json");
  const totalSlides = carousels.reduce((n, c) => n + (c.slides?.length || 0), 0);
  let done = 0;
  const tick = () => { try { fs.writeFileSync(progress, JSON.stringify({ done: ++done, total: totalSlides })); } catch {} };
  try { fs.writeFileSync(progress, JSON.stringify({ done: 0, total: totalSlides })); } catch {}

  const indexPath = path.join(tp.socialDir, "index.json");
  const index = readJSON(indexPath) || {};

  let rendered = 0, missing = 0;
  for (let i = 0; i < carousels.length; i++) {
    const c = carousels[i];
    const [w, h] = FORMATS[c.format] || FORMATS["4x5"];
    const bg = c.background === "blur" ? "blur" : (c.background || "FFFFFF");
    const dir = path.join(tp.socialDir, folderName(c, i));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    index[c.id] = path.relative(ROOT, dir);
    const slides = c.slides || [];
    console.log(`• ${folderName(c, i)} — ${slides.length} slide(s) @ ${w}x${h} (${c.format || "4x5"}, ${bg})`);
    for (let s = 0; s < slides.length; s++) {
      const src = source(slides[s]);
      const dest = path.join(dir, `${String(s + 1).padStart(2, "0")}.jpg`);
      if (src && (await compose(src, dest, w, h, bg))) rendered++;
      else { missing++; console.log(`  ⚠ slide ${s + 1}: no source for ${slides[s]}`); }
      tick();
    }
    if (c.caption && c.caption.trim()) await fsp.writeFile(path.join(dir, "caption.txt"), c.caption.trim() + "\n");
  }
  try { fs.rmSync(progress); } catch {}
  await fsp.writeFile(indexPath, JSON.stringify(index, null, 2));
  console.log(`\n✓ [${slug}] ${rendered} slide(s) rendered${missing ? `, ${missing} missing source` : ""}.`);
}
main().catch((e) => die(e.stack || String(e)));
