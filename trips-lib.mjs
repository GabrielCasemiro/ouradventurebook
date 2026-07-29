// Shared helper (server + scripts) to resolve per-trip paths and configs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = __dirname;
export const TRIPS_DIR = path.join(ROOT, "trips");

// Prefer the project's virtualenv Python (created by `npm run setup`) so the
// image scripts have Pillow; fall back to system python3.
export const PYTHON = fs.existsSync(path.join(ROOT, ".venv", "bin", "python3"))
  ? path.join(ROOT, ".venv", "bin", "python3")
  : "python3";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function tripPaths(slug) {
  const dir = path.join(TRIPS_DIR, slug);
  return {
    slug,
    dir,
    config: path.join(dir, "config.json"),
    photos: path.join(dir, "photos.json"),
    manifest: path.join(dir, "manifest.json"),
    project: path.join(dir, "project.json"),
    thumbs: path.join(dir, "thumbs"),
    web: path.join(dir, "web"),
    backups: path.join(dir, "backups"),
    exportDir: path.join(dir, "export"),
    exportRaw: path.join(dir, "export", "_raw"),
    exportMap: path.join(dir, "export-map.json"),
    exportUuids: path.join(dir, "export-uuids.txt"),
    book: path.join(dir, "book"),
    uploads: path.join(dir, "uploads"),       // original uploaded files
    uploadsJson: path.join(dir, "uploads.json"), // records for uploaded photos
    social: path.join(dir, "social.json"),    // social-media carousels
    socialDir: path.join(dir, "social"),      // rendered carousel exports
  };
}

export function readJSON(p, fb = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

export function readConfig(slug) {
  return readJSON(tripPaths(slug).config);
}

export function listTripSlugs() {
  try {
    return fs
      .readdirSync(TRIPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(TRIPS_DIR, d.name, "config.json")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function listTrips() {
  return listTripSlugs().map((slug) => ({ slug, ...(readConfig(slug) || {}) }));
}

// Resolve the slug from argv (scripts): `node x.mjs <slug>`; if absent and only
// one trip exists, use it.
export function resolveSlugFromArgs(argv = process.argv) {
  const arg = argv[2] && !argv[2].startsWith("-") ? argv[2] : null;
  if (arg) return arg;
  const slugs = listTripSlugs();
  if (slugs.length === 1) return slugs[0];
  if (slugs.length === 0) throw new Error("No trips in trips/. Create one first.");
  throw new Error(`Specify the trip: node <script> <slug>. Available: ${slugs.join(", ")}`);
}

export const DEFAULT_MATTE = { padColor: "FFFFFF" };
export const DEFAULT_BOOK = { pageW: 210, pageH: 300 };

// Compact EXIF/location metadata for a photo (from osxphotos JSON) for the lightbox.
export function photoMeta(p) {
  const e = p.exif_info || {};
  const m = {};
  const cam = [e.camera_make, e.camera_model].filter(Boolean).join(" ").trim();
  if (cam) m.camera = cam;
  if (e.lens_model) m.lens = e.lens_model;
  if (e.iso) m.iso = e.iso;
  if (e.aperture) m.aperture = e.aperture;
  if (e.focal_length) m.focalLength = e.focal_length;
  if (e.shutter_speed) m.shutter = e.shutter_speed;
  if (typeof p.latitude === "number") m.lat = p.latitude;
  if (typeof p.longitude === "number") m.lng = p.longitude;
  if (p.original_filesize) m.filesize = p.original_filesize;
  return Object.keys(m).length ? m : undefined;
}
