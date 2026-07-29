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
  // which photos have a high-res (HD) web render, and what it was rendered from
  const webSet = new Set(
    (fs.existsSync(tp.web) ? fs.readdirSync(tp.web) : [])
      .filter((f) => f.endsWith(".jpg") && !f.startsWith(".tmp"))
      .map((f) => f.slice(0, -4))
  );
  const webSources = readJSON(path.join(tp.web, ".sources.json")) || {};
  const photos = [...(base?.photos || []), ...uploads].map((p) => ({
    ...p,
    hd: webSet.has(p.uuid),
    hdSource: webSet.has(p.uuid) ? webSources[p.uuid] || "preview" : undefined,
  }));
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

// delete a photo from the catalog (removes its record and image files)
app.delete("/api/trips/:slug/photo/:uuid", withTrip, async (req, res) => {
  const uuid = String(req.params.uuid).replace(/[^0-9A-Za-z-]/g, "");
  if (!uuid) return res.status(400).json({ error: "bad_uuid" });

  // drop from the osxphotos manifest if present
  const base = readJSON(req.tp.manifest);
  if (base?.photos) {
    const kept = base.photos.filter((p) => p.uuid !== uuid);
    if (kept.length !== base.photos.length) {
      base.photos = kept;
      await fsp.writeFile(req.tp.manifest, JSON.stringify(base));
    }
  }
  // drop from uploads + delete the original file(s)
  const uploads = readJSON(req.tp.uploadsJson);
  if (Array.isArray(uploads) && uploads.some((r) => r.uuid === uuid)) {
    await fsp.writeFile(req.tp.uploadsJson, JSON.stringify(uploads.filter((r) => r.uuid !== uuid), null, 2));
    if (fs.existsSync(req.tp.uploads)) {
      for (const f of fs.readdirSync(req.tp.uploads)) {
        if (f.startsWith(uuid + ".")) await fsp.unlink(path.join(req.tp.uploads, f)).catch(() => {});
      }
    }
  }
  // delete generated images
  await fsp.unlink(path.join(req.tp.thumbs, `${uuid}.jpg`)).catch(() => {});
  await fsp.unlink(path.join(req.tp.web, `${uuid}.jpg`)).catch(() => {});
  res.json({ ok: true });
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

// run a child process to completion → { code, out, err }
function runScript(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: err + String(e) }));
  });
}

// Generate the digital-album HD renders (web/<uuid>.jpg) for any chosen/placed
// photo that's still missing one. Incremental (make-web skips existing files),
// so it's fast on repeat visits. Called automatically when the digital album opens.
app.post("/api/trips/:slug/web/prepare", withTrip, async (req, res) => {
  const web = await runScript(process.execPath, [path.join(ROOT, "scripts", "make-web.mjs"), req.params.slug]);
  res.json({ ok: web.code === 0, log: web.out || web.err });
});

// how many HD renders exist right now (for a live progress bar while preparing)
app.get("/api/trips/:slug/web/status", withTrip, (req, res) => {
  let count = 0;
  if (fs.existsSync(req.tp.web))
    count = fs.readdirSync(req.tp.web).filter((f) => f.endsWith(".jpg") && !f.startsWith(".tmp")).length;
  res.json({ count });
});

app.post("/api/trips/:slug/export/finish", withTrip, async (req, res) => {
  // 1) name the high-res files for the physical album (print)
  const rename = await runScript(PYTHON, [path.join(ROOT, "scripts", "rename-export.py"), req.params.slug]);
  if (rename.code !== 0)
    return res.status(500).json({ error: "rename_failed", code: rename.code, log: rename.out, stderr: rename.err });

  // 2) refresh the digital album's HD renders from the just-downloaded originals
  const web = await runScript(process.execPath, [path.join(ROOT, "scripts", "make-web.mjs"), req.params.slug]);
  let log = rename.out;
  log += "\n" + (web.code === 0
    ? web.out
    : "⚠ Print files are ready, but generating the digital-album HD images failed:\n" + (web.err || web.out));

  res.json({ ok: true, log });
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
