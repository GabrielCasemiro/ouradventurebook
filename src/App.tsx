import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import type { Manifest, Photo, PhotoState, Project, TripConfig } from "./lib/types";
import { countPlaced, countSheetsUsed, emptySheets } from "./lib/album";
import { Curadoria } from "./views/Curadoria";
import { Album } from "./views/Album";
import { ExportPanel } from "./views/ExportPanel";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface AppState {
  slug: string;
  config: TripConfig;
  manifest: Manifest;
  project: Project;
  photosByUuid: Map<string, Photo>;
  chosenSorted: Photo[];
  patchPhoto: (uuid: string, patch: PhotoState) => void;
  setProject: (updater: (p: Project) => Project) => void;
  reloadManifest: () => Promise<void>;
  saveStatus: SaveStatus;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp used outside provider");
  return c;
};

type View = "curadoria" | "album";

export function App({ slug }: { slug: string }) {
  const [config, setConfig] = useState<TripConfig | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [project, setProjectState] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("curadoria");
  const [activeDay, setActiveDay] = useState(1);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [showExport, setShowExport] = useState(false);

  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    api
      .config(slug)
      .then((cfg) => {
        setConfig(cfg);
        return Promise.all([api.manifest(slug).catch((e) => { throw e; }), api.getProject(slug)]);
      })
      .then(([m, p]) => {
        setManifest(m);
        setProjectState(p);
      })
      .catch((e) => {
        if (e.status === 404 && e.body?.error === "trip_not_found") setError("notfound");
        else setError(String(e.message || e));
      });
  }, [slug]);

  // ensure at least one sheet exists (the album is the source of truth for the count;
  // add/remove sheets from the Album view)
  useEffect(() => {
    if (!config || !project) return;
    if (project.album.sheets.length === 0) {
      setProjectState((prev) => (prev ? { ...prev, album: { sheets: emptySheets(1) } } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, project?.album.sheets.length]);

  const scheduleSave = useCallback((p: Project) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      setSaveStatus("saving");
      try { await api.putProject(slug, p); setSaveStatus("saved"); } catch { setSaveStatus("error"); }
    }, 600);
  }, [slug]);

  const setProject = useCallback((updater: (p: Project) => Project) => {
    setProjectState((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const patchPhoto = useCallback((uuid: string, patch: PhotoState) => {
    setProject((p) => ({ ...p, photos: { ...p.photos, [uuid]: { ...p.photos[uuid], ...patch } } }));
  }, [setProject]);

  const reloadManifest = useCallback(() => api.manifest(slug).then(setManifest).catch(() => {}), [slug]);

  const photosByUuid = useMemo(() => {
    const m = new Map<string, Photo>();
    manifest?.photos.forEach((ph) => m.set(ph.uuid, ph));
    return m;
  }, [manifest]);

  const chosenSorted = useMemo(() => {
    if (!manifest || !project) return [];
    return manifest.photos.filter((ph) => project.photos[ph.uuid]?.chosen);
  }, [manifest, project]);

  if (error === "notfound") return <ErrorScreen msg="Trip not found." />;
  if (error) return <ErrorScreen msg={error} />;
  if (!config || !manifest || !project) return <Splash />;

  const totalSlots = project.album.sheets.length * 4;
  const placed = countPlaced(project.album.sheets);
  const sheetsUsed = countSheetsUsed(project.album.sheets);

  const state: AppState = { slug, config, manifest, project, photosByUuid, chosenSorted, patchPhoto, setProject, reloadManifest, saveStatus };

  return (
    <Ctx.Provider value={state}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <a className="brand-back" href="/" title="All trips">‹</a>
            <span className="brand-castle">{config.emoji || "✦"}</span>
            <div>
              <h1>{config.title}</h1>
              <p className="brand-sub">{config.days} days · {config.kicker || "trip album"}</p>
            </div>
          </div>

          <nav className="tabs">
            <button className={view === "curadoria" ? "tab on" : "tab"} onClick={() => setView("curadoria")}>Curate</button>
            <button className={view === "album" ? "tab on" : "tab"} onClick={() => setView("album")}>Album</button>
          </nav>

          <div className="top-right">
            <div className="metrics">
              <Metric value={chosenSorted.length} label="chosen" />
              <Metric value={`${placed}/${totalSlots}`} label="placed" />
              <Metric value={`${sheetsUsed}/${project.album.sheets.length}`} label="sheets" />
            </div>
            <SaveBadge status={saveStatus} />
            <a className="btn-ghost sm" href={`/albuns/${slug}`} target="_blank" rel="noreferrer">Digital album ↗</a>
            <button className="btn-gold" onClick={() => setShowExport(true)}>Export</button>
          </div>
        </header>

        <main className="content">
          {view === "curadoria" ? (
            <Curadoria activeDay={activeDay} setActiveDay={setActiveDay} />
          ) : (
            <Album goCuradoria={() => setView("curadoria")} />
          )}
        </main>

        {showExport && <ExportPanel onClose={() => setShowExport(false)} />}
      </div>
    </Ctx.Provider>
  );
}

function Metric({ value, label }: { value: React.ReactNode; label: string }) {
  return <div className="metric"><span className="metric-value">{value}</span><span className="metric-label">{label}</span></div>;
}

function SaveBadge({ status }: { status: SaveStatus }) {
  const map: Record<SaveStatus, { t: string; c: string }> = {
    idle: { t: "saved", c: "ok" }, saving: { t: "saving…", c: "wait" },
    saved: { t: "saved ✓", c: "ok" }, error: { t: "save error", c: "err" },
  };
  const s = map[status];
  return <span className={`save-badge ${s.c}`}>{s.t}</span>;
}

function Splash() {
  return <div className="splash"><div className="splash-star">✦</div><p>Opening the album…</p></div>;
}

function ErrorScreen({ msg }: { msg: string }) {
  return <div className="setup"><div className="setup-card"><h2>Oops</h2><p>{msg}</p><p className="setup-hint"><a href="/">← all trips</a></p></div></div>;
}
