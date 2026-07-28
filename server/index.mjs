import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { ROOT, PYTHON, tripPaths, readJSON, readConfig, listTrips, listTripSlugs, SLUG_RE } from "../trips-lib.mjs";

const PORT = Number(process.env.PORT) || 4321;
const app = express();
app.use(express.json({ limit: "16mb" }));
const upload = multer({ dest: path.join(os.tmpdir(), "oab-uploads"), limits: { fileSize: 60 * 1024 * 1024 } });

const DIST = path.join(ROOT, "dist");

// ---- helpers -------------------------------------------------------------
const okSlug = (slug) => SLUG_RE.test(slug) && fs.existsSync(tripPaths(slug).dir);

const defaultProject = (cfg) => ({
  trip: { startDate: cfg.startDate, days: cfg.days },
  photos: {},
  album: { sheets: Array.from({ length: cfg.sheets || 50 }, () => ({ front: [null, null], back: [null, null] })) },
  updatedAt: null,
});

const projectStats = (project) => {
  if (!project) return { chosen: 0, placed: 0 };
  const chosen = Object.values(project.photos || {}).filter((v) => v?.chosen).length;
  let placed = 0;
  for (const s of project.album?.sheets || []) for (const side of ["front", "back"]) for (const u of s[side] || []) if (u) placed++;
  return { chosen, placed };
};

const dayIndexFactory = (cfg) => {
  const startMs = Date.parse(cfg.startDate + "T00:00:00");
  return (iso) => {
    const ms = Date.parse((iso || "").slice(0, 10) + "T00:00:00");
    if (Number.isNaN(ms)) return 1;
    return Math.min(Math.max(Math.round((ms - startMs) / 86400000) + 1, 1), cfg.days);
  };
};

// Merge the osxphotos-built manifest (if any) with uploaded photos into one manifest.
function mergedManifest(tp, cfg) {
  const base = readJSON(tp.manifest);
  const uploads = readJSON(tp.uploadsJson) || [];
  const startMs = Date.parse(cfg.startDate + "T00:00:00");
  const photos = [...(base?.photos || []), ...uploads];
  photos.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const days = Array.from({ length: cfg.days }, (_, i) => {
    const date = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    return { index: i + 1, date, label: `Day ${i + 1}`, count: photos.filter((p) => p.dayIndex === i + 1).length };
  });
  return { generatedAt: new Date().toISOString(), trip: { startDate: cfg.startDate, days: cfg.days }, days, photos };
}

// Run the Python uploader for one file; resolves to { width, height, date, meta } or null.
function ingestUpload(src, thumb, web) {
  return new Promise((resolve) => {
    const c = spawn(PYTHON, [path.join(ROOT, "scripts", "ingest-upload.py"), src, thumb, web]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    c.on("error", () => resolve(null));
  });
}

// middleware: validate :slug
const withTrip = (req, res, next) => {
  if (!okSlug(req.params.slug)) return res.status(404).json({ error: "trip_not_found" });
  req.tp = tripPaths(req.params.slug);
  req.cfg = readConfig(req.params.slug);
  next();
};

// ---- per-trip images -----------------------------------------------------
app.get("/trips/:slug/thumbs/:file", withTrip, (req, res) => {
  const p = path.join(req.tp.thumbs, path.basename(req.params.file));
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).end();
});
app.get("/trips/:slug/photo/:uuid", withTrip, (req, res) => {
  const uuid = String(req.params.uuid).replace(/[^0-9A-Za-z-]/g, "");
  const web = path.join(req.tp.web, `${uuid}.jpg`);
  const thumb = path.join(req.tp.thumbs, `${uuid}.jpg`);
  if (fs.existsSync(web)) return res.sendFile(web);
  if (fs.existsSync(thumb)) return res.sendFile(thumb);
  res.status(404).end();
});

// ---- list / create trips -------------------------------------------------
app.get("/api/trips", (_req, res) => {
  const trips = listTrips().map((t) => {
    const tp = tripPaths(t.slug);
    const project = readJSON(tp.project);
    const hasPhotos = fs.existsSync(tp.manifest) || fs.existsSync(tp.uploadsJson);
    return { ...t, hasPhotos, ...projectStats(project) };
  });
  res.json(trips);
});

app.post("/api/trips", async (req, res) => {
  const b = req.body || {};
  const slug = String(b.slug || "").trim();
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "invalid_slug", hint: "use lowercase letters, numbers and hyphens" });
  if (fs.existsSync(tripPaths(slug).dir)) return res.status(409).json({ error: "slug_exists" });
  const cfg = {
    slug,
    title: String(b.title || slug).slice(0, 120),
    kicker: String(b.kicker || "").slice(0, 60),
    emoji: String(b.emoji || "✦").slice(0, 8),
    startDate: b.startDate,
    days: Math.max(1, Math.min(90, Number(b.days) || 1)),
    sheets: Math.max(1, Math.min(200, Number(b.sheets) || 50)),
    queryFrom: b.queryFrom || b.startDate,
    queryTo: b.queryTo || b.startDate,
    matte: { padColor: "FFFFFF" },
    music: b.music || null,
    book: { pageW: 210, pageH: 300 },
  };
  const tp = tripPaths(slug);
  await fsp.mkdir(tp.dir, { recursive: true });
  await fsp.writeFile(tp.config, JSON.stringify(cfg, null, 2));
  res.json({ ok: true, trip: cfg });
});

app.get("/api/trips/:slug/config", withTrip, (req, res) => res.json(req.cfg));

// ---- per-trip manifest / project -----------------------------------------
app.get("/api/trips/:slug/manifest", withTrip, (req, res) => {
  res.json(mergedManifest(req.tp, req.cfg));
});

// upload photos straight into the trip (no iCloud needed)
app.post("/api/trips/:slug/upload", withTrip, upload.array("files", 300), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "no_files" });
  const dayIndex = Math.max(1, Math.min(req.cfg.days, Number(req.body.dayIndex) || 1));
  const dayDate = new Date(Date.parse(req.cfg.startDate + "T00:00:00") + (dayIndex - 1) * 86400000).toISOString().slice(0, 10);
  const replaceMode = req.body.mode === "replace";

  await fsp.mkdir(req.tp.uploads, { recursive: true });
  await fsp.mkdir(req.tp.thumbs, { recursive: true });
  await fsp.mkdir(req.tp.web, { recursive: true });
  const uploads = readJSON(req.tp.uploadsJson) || [];
  const byName = new Map();
  if (replaceMode) for (const r of uploads) if (!byName.has(r.filename)) byName.set(r.filename, r);
  let added = 0, replaced = 0, failed = 0;

  for (const f of files) {
    const existing = replaceMode ? byName.get(f.originalname) : null;
    const uuid = existing ? existing.uuid : "up-" + crypto.randomUUID();
    const ext = (path.extname(f.originalname) || ".jpg").toLowerCase();
    const orig = path.join(req.tp.uploads, uuid + ext);
    // when replacing, drop any previous original with a different extension
    if (existing && fs.existsSync(req.tp.uploads)) {
      for (const old of fs.readdirSync(req.tp.uploads)) {
        if (old.startsWith(uuid + ".") && path.join(req.tp.uploads, old) !== orig) await fsp.unlink(path.join(req.tp.uploads, old)).catch(() => {});
      }
    }
    try { await fsp.rename(f.path, orig); } catch { await fsp.copyFile(f.path, orig); await fsp.unlink(f.path).catch(() => {}); }

    const info = await ingestUpload(orig, path.join(req.tp.thumbs, `${uuid}.jpg`), path.join(req.tp.web, `${uuid}.jpg`));
    if (!info) { failed++; if (!existing) await fsp.unlink(orig).catch(() => {}); continue; }

    if (existing) {
      existing.width = info.width || existing.width;
      existing.height = info.height || existing.height;
      existing.date = info.date || existing.date;
      existing.meta = info.meta || existing.meta;
      existing.hasThumb = true;
      replaced++;
    } else {
      uploads.push({
        uuid,
        filename: f.originalname,
        date: info.date || `${dayDate}T12:00:00`,
        dayIndex, // land on the day the user is viewing
        width: info.width || 0,
        height: info.height || 0,
        isFavorite: false,
        hasThumb: true,
        sig: uuid,
        meta: info.meta || undefined,
        source: "upload",
      });
      added++;
    }
  }
  await fsp.writeFile(req.tp.uploadsJson, JSON.stringify(uploads, null, 2));
  res.json({ ok: true, added, replaced, failed, dayIndex });
});

app.get("/api/trips/:slug/project", withTrip, async (req, res) => {
  let project = readJSON(req.tp.project);
  if (!project) {
    project = defaultProject(req.cfg);
    await fsp.writeFile(req.tp.project, JSON.stringify(project, null, 2));
  }
  res.json(project);
});

app.put("/api/trips/:slug/project", withTrip, async (req, res) => {
  const project = req.body;
  if (!project || typeof project !== "object") return res.status(400).json({ error: "invalid_project" });
  project.updatedAt = new Date().toISOString();
  await fsp.writeFile(req.tp.project, JSON.stringify(project, null, 2));
  res.json({ ok: true, updatedAt: project.updatedAt });
});

app.post("/api/trips/:slug/backup", withTrip, async (req, res) => {
  const project = readJSON(req.tp.project);
  if (!project) return res.status(404).json({ error: "no_project" });
  await fsp.mkdir(req.tp.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(req.tp.backups, `project.${stamp}.json`);
  await fsp.writeFile(dest, JSON.stringify(project, null, 2));
  res.json({ ok: true, file: path.relative(ROOT, dest) });
});

// ---- export --------------------------------------------------------------
app.post("/api/trips/:slug/export/prepare", withTrip, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "no_items" });
  const options = req.body?.options || { matteVertical: true, padColor: req.cfg.matte?.padColor || "FFFFFF" };
  const uuids = items.map((it) => it.uuid);
  const rel = `trips/${req.params.slug}`;

  await fsp.mkdir(req.tp.exportRaw, { recursive: true });
  await fsp.writeFile(req.tp.exportMap, JSON.stringify({ items, options }, null, 2));

  // uploaded photos aren't in iCloud — copy their originals straight into _raw,
  // and only ask osxphotos to download the ones that came from Apple Photos.
  const uploadRecs = readJSON(req.tp.uploadsJson) || [];
  const uploadedSet = new Set(uploadRecs.map((r) => r.uuid));
  const uploadFiles = fs.existsSync(req.tp.uploads) ? fs.readdirSync(req.tp.uploads) : [];
  let copied = 0;
  for (const u of uuids) {
    if (!uploadedSet.has(u)) continue;
    const f = uploadFiles.find((x) => x.startsWith(u + "."));
    if (f) { await fsp.copyFile(path.join(req.tp.uploads, f), path.join(req.tp.exportRaw, f)); copied++; }
  }
  const osxUuids = uuids.filter((u) => !uploadedSet.has(u));
  await fsp.writeFile(req.tp.exportUuids, osxUuids.join("\n") + "\n");

  // run from the project root (skip if there are no Apple Photos to download)
  const command =
    `osxphotos export ${rel}/export/_raw ` +
    `--uuid-from-file ${rel}/export-uuids.txt --download-missing --use-photokit ` +
    `--convert-to-jpeg --jpeg-quality 0.92 --filename "{uuid}" ` +
    `--skip-live --skip-raw --retry 3 --report ${rel}/export-full-report.csv`;
  res.json({ ok: true, count: osxUuids.length, uploadsCopied: copied, command });
});

app.post("/api/trips/:slug/export/finish", withTrip, (req, res) => {
  const child = spawn(PYTHON, [path.join(ROOT, "scripts", "rename-export.py"), req.params.slug], { cwd: ROOT });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("close", (code) => {
    if (code === 0) res.json({ ok: true, log: out });
    else res.status(500).json({ error: "rename_failed", code, log: out, stderr: err });
  });
});

// ---- frontend (production) -----------------------------------------------
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api|\/trips\/[^/]+\/(thumbs|photo)).*/, (_req, res) => res.sendFile(path.join(DIST, "index.html")));
}

app.listen(PORT, () => {
  console.log(`\n  ✦  OurAdventureBook — server at http://localhost:${PORT}`);
  console.log(`     trips: ${listTripSlugs().join(", ") || "(none)"}\n`);
});
