import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { ROOT, PYTHON, tripPaths, readJSON, readConfig, listTrips, listTripSlugs, SLUG_RE } from "../trips-lib.mjs";
import { analyzeLibrary } from "../discover.mjs";

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

// per-trip photo import (osxphotos → photos.json → thumbnails)
let importState = { running: false, slug: null, phase: "", done: 0, total: 0, status: "", startedAt: 0, error: null };
const importCommand = (cfg) =>
  `cd ${ROOT} && osxphotos query --from-date ${cfg.queryFrom} --to-date ${cfg.queryTo} ` +
  `--only-photos --mute --json > trips/${cfg.slug}/photos.json && npm run thumbs -- ${cfg.slug}`;

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

// ---- trip discovery (suggest trips from the Photos library) ---------------
const DISCOVERY_DIR = path.join(ROOT, "data", "discovery");
const DISCOVERY_SETTINGS = path.join(DISCOVERY_DIR, "settings.json");
const DISCOVERY_LIB = path.join(DISCOVERY_DIR, "library.tsv");
// Only the fields we need, one short line per photo — far smaller and faster
// than a full --json dump (which serializes every field for every photo).
const DISCOVERY_TEMPLATE =
  "{created.date}{tab}{photo.latitude,}{tab}{photo.longitude,}{tab}{place.country_code,}{tab}{place.name.country,}{tab}{place.name.city,}{tab}{place.name.area_of_interest,}";

let syncState = { running: false, done: 0, total: 0, status: "", startedAt: 0, sizeMB: 0, error: null };

const isoDay = (d) => d.toISOString().slice(0, 10);
const discoveryDefaults = () => {
  const to = new Date();
  const from = new Date(); from.setFullYear(from.getFullYear() - 3);
  return { from: isoDay(from), to: isoDay(to), homeKey: null };
};
const discoverySettings = () => ({ ...discoveryDefaults(), ...(readJSON(DISCOVERY_SETTINGS) || {}) });
const discoveryCommand = (s) =>
  `cd ${ROOT} && mkdir -p data/discovery && ` +
  `osxphotos query --from-date ${s.from} --to-date ${s.to} --quiet --print "${DISCOVERY_TEMPLATE}" > data/discovery/library.tsv`;

// parse the compact TSV (or a legacy JSON dump) into records for analyzeLibrary
function readDiscoveryLibrary() {
  const text = fs.readFileSync(DISCOVERY_LIB, "utf8");
  if (text.trimStart().startsWith("[")) {
    const arr = JSON.parse(text.replace(/\bNaN\b/g, "null"));
    return Array.isArray(arr) ? arr : arr?.photos || [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [date, lat, lon, cc, country, city, aoi] = line.split("\t");
    out.push({ date, lat, lon, cc, country, city, aoi });
  }
  return out;
}

app.get("/api/discovery", (_req, res) => {
  const s = discoverySettings();
  let libraryInfo = null;
  if (fs.existsSync(DISCOVERY_LIB)) {
    const st = fs.statSync(DISCOVERY_LIB);
    libraryInfo = { syncedAt: st.mtime.toISOString(), sizeMB: +(st.size / 1048576).toFixed(1) };
  }
  res.json({ settings: s, hasLibrary: !!libraryInfo, libraryInfo, command: discoveryCommand(s) });
});

app.put("/api/discovery", async (req, res) => {
  const b = req.body || {};
  const cur = discoverySettings();
  const next = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(b.from) ? b.from : cur.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(b.to) ? b.to : cur.to,
    homeKey: typeof b.homeKey === "string" || b.homeKey === null ? b.homeKey : cur.homeKey,
  };
  await fsp.mkdir(DISCOVERY_DIR, { recursive: true });
  await fsp.writeFile(DISCOVERY_SETTINGS, JSON.stringify(next, null, 2));
  res.json({ ok: true, settings: next, command: discoveryCommand(next) });
});

// run osxphotos directly (works when the terminal running the server has Full
// Disk Access). Streams the metadata JSON straight to data/discovery/library.json.
app.get("/api/discovery/sync/progress", (_req, res) => {
  const elapsed = syncState.running ? Date.now() - syncState.startedAt : 0;
  res.json({ ...syncState, elapsed });
});

app.post("/api/discovery/sync", async (req, res) => {
  const s = discoverySettings();
  await fsp.mkdir(DISCOVERY_DIR, { recursive: true });
  const out = fs.createWriteStream(DISCOVERY_LIB);
  let err = "", sent = false, closedCode = null, fileDone = false;
  syncState = { running: true, done: 0, total: 0, status: "Starting osxphotos…", startedAt: Date.now(), sizeMB: 0, error: null };
  const stopState = (error = null) => { syncState = { ...syncState, running: false, error }; };
  const fail = (body, status = 500) => { if (sent) return; sent = true; try { out.destroy(); } catch {} stopState(body.error || "failed"); res.status(status).json(body); };
  const finish = () => {
    if (sent || closedCode === null || !fileDone) return;
    if (closedCode === 0) {
      sent = true;
      const st = fs.statSync(DISCOVERY_LIB);
      stopState();
      res.json({ ok: true, libraryInfo: { syncedAt: st.mtime.toISOString(), sizeMB: +(st.size / 1048576).toFixed(1) } });
    } else {
      const perm = /full disk access|not authorized|operation not permitted|unable to open|permission|photos library|osxphotos.db/i.test(err);
      fail({ error: perm ? "permission" : "osxphotos_failed", code: closedCode, stderr: err.slice(-2000) });
    }
  };
  // reflect how much has been written so far (some osxphotos versions stream)
  const sizeTimer = setInterval(() => {
    try { if (syncState.running) syncState.sizeMB = +(fs.statSync(DISCOVERY_LIB).size / 1048576).toFixed(1); } catch {}
  }, 800);

  let child;
  try { child = spawn("osxphotos", ["query", "--from-date", s.from, "--to-date", s.to, "--quiet", "--print", DISCOVERY_TEMPLATE]); }
  catch (e) { clearInterval(sizeTimer); return fail({ error: "not_found", message: String(e.message || e) }); }
  child.on("error", (e) => { clearInterval(sizeTimer); fail({ error: e.code === "ENOENT" ? "not_found" : "spawn_failed", message: String(e.message || e) }); });
  child.stdout.pipe(out);
  child.stderr.on("data", (d) => {
    err += d;
    // parse the latest progress line osxphotos prints to stderr
    const lines = String(d).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) {
      const friendly = /done processing/i.test(last) ? "Almost done, writing metadata…"
        : /processing/i.test(last) ? "Reading your library…" : last;
      syncState.status = friendly.slice(0, 120);
      const m = last.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (m) { syncState.done = +m[1].replace(/,/g, ""); syncState.total = +m[2].replace(/,/g, ""); }
      else { const p = last.match(/(\d+)%/); if (p) { syncState.done = +p[1]; syncState.total = 100; } }
    }
  });
  out.on("finish", () => { fileDone = true; clearInterval(sizeTimer); finish(); });
  out.on("error", () => { clearInterval(sizeTimer); fail({ error: "write_failed" }); });
  child.on("close", (code) => { closedCode = code; finish(); });
});

app.post("/api/discovery/analyze", async (req, res) => {
  if (!fs.existsSync(DISCOVERY_LIB)) return res.status(400).json({ error: "no_library" });
  let photos;
  try { photos = readDiscoveryLibrary(); }
  catch (e) { return res.status(500).json({ error: "bad_library", message: String(e.message || e) }); }

  const s = discoverySettings();
  const homeKey = typeof req.body?.homeKey === "string" ? req.body.homeKey : s.homeKey;
  if (req.body?.homeKey !== undefined && req.body.homeKey !== s.homeKey) {
    await fsp.mkdir(DISCOVERY_DIR, { recursive: true });
    await fsp.writeFile(DISCOVERY_SETTINGS, JSON.stringify({ ...s, homeKey }, null, 2));
  }

  const existingRanges = listTrips().map((t) => {
    const start = t.startDate;
    const end = isoDay(new Date(Date.parse(start + "T00:00:00") + (t.days - 1) * 86400000));
    return { start, end };
  });
  const result = analyzeLibrary(photos, { homeKey, existingRanges });
  res.json({ ...result, count: photos.length });
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

app.put("/api/trips/:slug/config", withTrip, async (req, res) => {
  const b = req.body || {};
  const next = { ...req.cfg };
  if (typeof b.title === "string") next.title = b.title.slice(0, 120);
  if (typeof b.kicker === "string") next.kicker = b.kicker.slice(0, 60);
  if (typeof b.emoji === "string") next.emoji = b.emoji.slice(0, 8) || "✦";
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.startDate)) next.startDate = b.startDate;
  if (b.days != null) next.days = Math.max(1, Math.min(90, Number(b.days) || req.cfg.days));
  if (b.sheets != null) next.sheets = Math.max(1, Math.min(200, Number(b.sheets) || req.cfg.sheets));
  if (b.music !== undefined) next.music = b.music ? String(b.music).slice(0, 200) : null;
  await fsp.writeFile(req.tp.config, JSON.stringify(next, null, 2));
  res.json({ ok: true, trip: next });
});

// ---- per-trip manifest / project -----------------------------------------
app.get("/api/trips/:slug/manifest", withTrip, (req, res) => {
  res.json(mergedManifest(req.tp, req.cfg));
});

// import command + live progress of an in-flight import for this trip
app.get("/api/trips/:slug/import", withTrip, (req, res) => {
  const st = importState.running && importState.slug === req.params.slug ? importState : { running: false, phase: "", done: 0, total: 0, status: "" };
  const elapsed = st.running ? Date.now() - st.startedAt : 0;
  res.json({ command: importCommand(req.cfg), running: st.running, phase: st.phase, done: st.done, total: st.total, status: st.status, elapsed });
});

// run osxphotos to write photos.json, then make-thumbs for thumbnails + manifest
app.post("/api/trips/:slug/import", withTrip, (req, res) => {
  if (importState.running) return res.status(409).json({ error: "busy", slug: importState.slug });
  const cfg = req.cfg, tp = req.tp, slug = req.params.slug;
  importState = { running: true, slug, phase: "photos", done: 0, total: 0, status: "Reading your library…", startedAt: Date.now(), error: null };
  let sent = false, err = "";
  const stop = (error = null) => { importState = { ...importState, running: false, error }; };
  const fail = (body, status = 500) => { if (sent) return; sent = true; stop(body.error || "failed"); res.status(status).json(body); };
  const finishOk = () => { if (sent) return; sent = true; stop(); res.json({ ok: true }); };

  // phase 1: osxphotos metadata → photos.json
  const out = fs.createWriteStream(tp.photos);
  let file1Done = false, code1 = null;
  const afterPhotos = () => {
    if (!file1Done || code1 === null) return;
    if (code1 !== 0) {
      const perm = /full disk access|not authorized|operation not permitted|unable to open|permission|photos library/i.test(err);
      return fail({ error: perm ? "permission" : "osxphotos_failed", code: code1, stderr: err.slice(-2000) });
    }
    startThumbs();
  };
  let child1;
  try { child1 = spawn("osxphotos", ["query", "--from-date", cfg.queryFrom, "--to-date", cfg.queryTo, "--only-photos", "--mute", "--json"]); }
  catch (e) { try { out.destroy(); } catch {} return fail({ error: "not_found", message: String(e.message || e) }); }
  child1.on("error", (e) => { try { out.destroy(); } catch {} fail({ error: e.code === "ENOENT" ? "not_found" : "spawn_failed", message: String(e.message || e) }); });
  child1.stdout.pipe(out);
  child1.stderr.on("data", (d) => {
    err += d;
    const lines = String(d).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) {
      importState.status = /done processing/i.test(last) ? "Almost done reading the library…" : /processing/i.test(last) ? "Reading your library…" : last.slice(0, 120);
      const m = last.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (m) { importState.done = +m[1].replace(/,/g, ""); importState.total = +m[2].replace(/,/g, ""); }
    }
  });
  out.on("finish", () => { file1Done = true; afterPhotos(); });
  out.on("error", () => fail({ error: "write_failed" }));
  child1.on("close", (c) => { code1 = c; afterPhotos(); });

  // phase 2: thumbnails + manifest
  function startThumbs() {
    importState = { ...importState, phase: "thumbs", done: 0, total: 0, status: "Making thumbnails…" };
    const progFile = path.join(tp.thumbs, ".progress.json");
    const timer = setInterval(() => { try { const p = readJSON(progFile); if (p) { importState.done = p.done || 0; importState.total = p.total || 0; } } catch {} }, 500);
    let terr = "", child2;
    try { child2 = spawn(process.execPath, [path.join(ROOT, "scripts", "make-thumbs.mjs"), slug]); }
    catch (e) { clearInterval(timer); return fail({ error: "spawn_failed", message: String(e.message || e) }); }
    child2.stderr.on("data", (d) => (terr += d));
    child2.on("error", (e) => { clearInterval(timer); fail({ error: "spawn_failed", message: String(e.message || e) }); });
    child2.on("close", (c) => { clearInterval(timer); if (c === 0) finishOk(); else fail({ error: "thumbs_failed", code: c, stderr: terr.slice(-2000) }); });
  }
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

// ---- social carousels ----------------------------------------------------
app.get("/api/trips/:slug/social", withTrip, (req, res) => {
  res.json(readJSON(req.tp.social) || { carousels: [] });
});

app.put("/api/trips/:slug/social", withTrip, async (req, res) => {
  const social = req.body;
  if (!social || typeof social !== "object" || !Array.isArray(social.carousels))
    return res.status(400).json({ error: "invalid_social" });
  social.updatedAt = new Date().toISOString();
  await fsp.writeFile(req.tp.social, JSON.stringify(social, null, 2));
  res.json({ ok: true, updatedAt: social.updatedAt });
});

// render one carousel (or all) to social/<id>/NN.jpg + caption.txt
app.post("/api/trips/:slug/social/export", withTrip, async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const args = [path.join(ROOT, "scripts", "make-social.mjs"), req.params.slug];
  if (id) args.push(id);
  const r = await runScript(process.execPath, args);
  if (r.code !== 0) return res.status(500).json({ error: "render_failed", log: r.out, stderr: r.err });
  const index = readJSON(path.join(req.tp.socialDir, "index.json")) || {};
  res.json({ ok: true, log: r.out, dir: `trips/${req.params.slug}/social`, folder: id ? index[id] : undefined });
});

// reveal an exported carousel folder in Finder (macOS)
app.post("/api/trips/:slug/social/reveal", withTrip, (req, res) => {
  const id = String(req.body?.id || "");
  const index = readJSON(path.join(req.tp.socialDir, "index.json")) || {};
  const rel = index[id];
  if (!rel) return res.status(404).json({ error: "not_exported" });
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(req.tp.socialDir)) return res.status(400).json({ error: "bad_path" });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: "missing" });
  spawn("open", [abs]);
  res.json({ ok: true });
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

  // paths are relative to the project root, so cd there first (copy-paste safe from anywhere)
  const command =
    `cd ${ROOT} && osxphotos export ${rel}/export/_raw ` +
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

// live progress of an in-flight make-web run (for a progress bar); running:false when idle
app.get("/api/trips/:slug/web/progress", withTrip, (req, res) => {
  const f = path.join(req.tp.web, ".progress.json");
  if (fs.existsSync(f)) {
    const p = readJSON(f) || {};
    return res.json({ running: true, done: p.done || 0, total: p.total || 0 });
  }
  res.json({ running: false, done: 0, total: 0 });
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
