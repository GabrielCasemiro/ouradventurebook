import type { Manifest, Project, TripConfig, TripSummary } from "./types";

const j = async (r: Response) => {
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body: await r.json().catch(() => ({})) });
  return r.json();
};

const base = (slug: string) => `/api/trips/${encodeURIComponent(slug)}`;

export const api = {
  trips: (): Promise<TripSummary[]> => fetch("/api/trips").then(j),
  createTrip: (body: Partial<TripConfig>): Promise<{ ok: boolean; trip: TripConfig }> =>
    fetch("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(j),

  config: (slug: string): Promise<TripConfig> => fetch(`${base(slug)}/config`).then(j),
  manifest: (slug: string): Promise<Manifest> => fetch(`${base(slug)}/manifest`).then(j),
  getProject: (slug: string): Promise<Project> => fetch(`${base(slug)}/project`).then(j),
  putProject: (slug: string, p: Project): Promise<{ ok: boolean; updatedAt: string }> =>
    fetch(`${base(slug)}/project`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).then(j),
  backup: (slug: string): Promise<{ ok: boolean; file: string }> => fetch(`${base(slug)}/backup`, { method: "POST" }).then(j),
  exportPrepare: (slug: string, items: unknown[], options?: unknown): Promise<{ ok: boolean; count: number; command: string }> =>
    fetch(`${base(slug)}/export/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, options }) }).then(j),
  exportFinish: (slug: string): Promise<{ ok: boolean; log: string }> => fetch(`${base(slug)}/export/finish`, { method: "POST" }).then(j),
  prepareWeb: (slug: string): Promise<{ ok: boolean; log: string }> => fetch(`${base(slug)}/web/prepare`, { method: "POST" }).then(j),
  webStatus: (slug: string): Promise<{ count: number }> => fetch(`${base(slug)}/web/status`).then(j),
  uploadPhotos: (
    slug: string,
    files: FileList | File[],
    dayIndex: number,
    mode: "keepboth" | "replace" = "keepboth"
  ): Promise<{ ok: boolean; added: number; replaced: number; failed: number; dayIndex: number }> => {
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
    fd.append("dayIndex", String(dayIndex));
    fd.append("mode", mode);
    return fetch(`${base(slug)}/upload`, { method: "POST", body: fd }).then(j);
  },
  deletePhoto: (slug: string, uuid: string): Promise<{ ok: boolean }> =>
    fetch(`${base(slug)}/photo/${encodeURIComponent(uuid)}`, { method: "DELETE" }).then(j),
};

export const thumbUrl = (slug: string, uuid: string) => `/trips/${slug}/thumbs/${uuid}.jpg`;
// `v` (e.g. the render source) busts the browser cache when the same photo URL
// starts serving a different (upgraded) image.
export const photoUrl = (slug: string, uuid: string, v?: string) =>
  `/trips/${slug}/photo/${uuid}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
