// Transcode chosen/placed videos to <trip>/web/<uuid>.mp4 (H.264/AAC, faststart)
// so they play in every browser inside the digital album, plus a poster frame in
// <trip>/thumbs/<uuid>.jpg when one is missing. The full clip is kept (no trimming);
// resolution is only capped at 1080p to stay universally playable. Videos never go
// into the printed book. Needs ffmpeg on the PATH. Usage: node scripts/make-videos.mjs <slug>
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSlugFromArgs, tripPaths, readJSON } from "../trips-lib.mjs";

const MAX_W = 1920; // cap width at 1080p; portrait clips keep their height
const die = (m) => { console.error("✖ " + m); process.exit(1); };

const slug = resolveSlugFromArgs();
// optional: a single uuid to transcode on demand (even if it isn't chosen/placed yet)
const onlyUuid = process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : null;
const tp = tripPaths(slug);
const project = readJSON(tp.project) || die("No project.json for " + slug);
if (!fs.existsSync(tp.photos)) die(`Missing ${slug}/photos.json — run the import first.`);

const parsePhotos = () => {
  const t = fs.readFileSync(tp.photos, "utf8").replace(/\bNaN\b/g, "null").replace(/-?\bInfinity\b/g, "null");
  const raw = JSON.parse(t);
  return Array.isArray(raw) ? raw : raw?.photos ?? [];
};

// only prepare videos the user actually put in the album (placed or chosen)
const used = new Set();
for (const s of project.album.sheets) for (const sd of ["front", "back"]) for (const u of s[sd]) if (u) used.add(u);
for (const [u, v] of Object.entries(project.photos || {})) if (v?.chosen) used.add(u);

const VIDEO_EXT = ["mov", "MOV", "mp4", "MP4", "m4v", "M4V"];
// source order: an exported original in export/_raw, else the library original if it's local
const sourceFor = (uuid, p) => {
  for (const ext of VIDEO_EXT) {
    const q = path.join(tp.exportRaw, `${uuid}.${ext}`);
    if (fs.existsSync(q)) return q;
  }
  if (p?.path && fs.existsSync(p.path)) return p.path;
  if (p?.path_edited && fs.existsSync(p.path_edited)) return p.path_edited;
  return null;
};

const run = (cmd, args) => new Promise((res) => {
  const c = spawn(cmd, args, { stdio: "ignore" });
  c.on("close", (code) => res(code === 0));
  c.on("error", () => res(false));
});

async function main() {
  await fsp.mkdir(tp.web, { recursive: true });
  await fsp.mkdir(tp.thumbs, { recursive: true });
  const byUuid = new Map(parsePhotos().map((p) => [p.uuid, p]));
  // a single explicit uuid (on-demand from the editor) takes priority over the
  // chosen/placed set, so you can preview a video before adding it to the album
  const candidates = onlyUuid ? [onlyUuid] : [...used];
  const videos = candidates.filter((u) => byUuid.get(u)?.ismovie);
  if (!videos.length) { console.log(`• [${slug}] No videos to prepare.`); return; }

  console.log(`• [${slug}] Preparing ${videos.length} video(s)…`);
  let ok = 0, missing = 0, done = 0;
  for (const uuid of videos) {
    const p = byUuid.get(uuid);
    const src = sourceFor(uuid, p);
    const mp4 = path.join(tp.web, `${uuid}.mp4`);
    const poster = path.join(tp.thumbs, `${uuid}.jpg`);
    if (!src) {
      missing++;
      console.log(`  ⚠ ${uuid}: original not on this Mac — run Export (or keep it downloaded) then retry.`);
      continue;
    }
    if (!fs.existsSync(mp4)) {
      const tmp = path.join(tp.web, `.tmp-${uuid}.mp4`);
      const good = await run("ffmpeg", [
        "-y", "-i", src,
        "-vf", `scale='min(${MAX_W},iw)':-2`,
        "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", tmp,
      ]);
      if (good && fs.existsSync(tmp)) { await fsp.rename(tmp, mp4); }
      else { try { fs.rmSync(tmp); } catch {} missing++; console.log(`  ⚠ ${uuid}: ffmpeg transcode failed.`); continue; }
    }
    // poster from a real frame if Photos didn't leave a JPEG derivative behind
    if (!fs.existsSync(poster)) {
      await run("ffmpeg", ["-y", "-ss", "0.5", "-i", src, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", poster]);
    }
    ok++; done++;
    console.log(`  ✓ ${uuid} (${done}/${videos.length})`);
  }
  console.log(`\n✓ [${slug}] ${ok} video(s) ready${missing ? `, ${missing} missing a usable source` : ""}.`);
}
main().catch((e) => die(e.stack || String(e)));
