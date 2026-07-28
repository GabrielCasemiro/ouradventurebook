import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ROOT, PYTHON, tripPaths, readJSON, readConfig, listTrips, listTripSlugs, SLUG_RE } from "../trips-lib.mjs";

const PORT = Number(process.env.PORT) || 4321;
const app = express();
app.use(express.json({ limit: "16mb" }));

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
  const uuid = String(req.params.uuid).replace(/[^0-9A-Fa-f-]/g, "");
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
    const hasPhotos = fs.existsSync(tp.manifest);
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
  const manifest = readJSON(req.tp.manifest);
  if (!manifest) return res.status(404).json({ error: "manifest_missing" });
  res.json(manifest);
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
  await fsp.writeFile(req.tp.exportUuids, uuids.join("\n") + "\n");
  await fsp.writeFile(req.tp.exportMap, JSON.stringify({ items, options }, null, 2));

  // run from the project root
  const command =
    `osxphotos export ${rel}/export/_raw ` +
    `--uuid-from-file ${rel}/export-uuids.txt --download-missing --use-photokit ` +
    `--convert-to-jpeg --jpeg-quality 0.92 --filename "{uuid}" ` +
    `--skip-live --skip-raw --retry 3 --report ${rel}/export-full-report.csv`;
  res.json({ ok: true, count: uuids.length, command });
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
