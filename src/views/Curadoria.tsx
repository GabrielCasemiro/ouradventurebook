import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../App";
import { api } from "../lib/api";
import { thumbUrl } from "../lib/api";
import type { Photo } from "../lib/types";
import { Lightbox } from "../components/Lightbox";

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}`;
};
const fmtElapsed = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function Curadoria({
  activeDay,
  setActiveDay,
}: {
  activeDay: number;
  setActiveDay: (d: number) => void;
}) {
  const { slug, config, manifest, project, patchPhoto, reloadManifest, setProject } = useApp();
  const [onlyChosen, setOnlyChosen] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [hideDupes, setHideDupes] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dupe, setDupe] = useState<{ files: File[]; count: number } | null>(null);
  const [pendingDel, setPendingDel] = useState<{ uuid: string; filename: string; sheet: number | null } | null>(null);
  const [importCmd, setImportCmd] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProg, setImportProg] = useState<{ phase: string; done: number; total: number; status: string; elapsed: number } | null>(null);
  const [importManual, setImportManual] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importCopied, setImportCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showImport && importCmd === null) api.importInfo(slug).then((i) => setImportCmd(i.command)).catch(() => {});
  }, [showImport, slug, importCmd]);

  const doImport = async () => {
    setImporting(true); setImportMsg(null);
    setImportProg({ phase: "photos", done: 0, total: 0, status: "Starting…", elapsed: 0 });
    const poll = window.setInterval(async () => {
      try { const p = await api.importInfo(slug); if (p.running) setImportProg({ phase: p.phase, done: p.done, total: p.total, status: p.status, elapsed: p.elapsed }); } catch {}
    }, 700);
    try {
      await api.runImport(slug);
      window.clearInterval(poll); setImportProg(null); setImporting(false);
      await reloadManifest();
      setShowImport(false);
      setToast("Photos imported ✓"); setTimeout(() => setToast(null), 2500);
    } catch (e: any) {
      window.clearInterval(poll); setImportProg(null); setImporting(false);
      const err = e.body?.error;
      if (err === "permission") { setImportManual(true); setImportMsg("Your terminal doesn't have Full Disk Access, so the app can't read Photos. Grant it in System Settings › Privacy & Security › Full Disk Access (add your terminal), restart it, then try again — or run the command below."); }
      else if (err === "not_found") { setImportManual(true); setImportMsg("osxphotos isn't installed or isn't on the PATH. Run `npm run setup`, or use the command below."); }
      else if (err === "busy") { setImportMsg("An import is already running."); }
      else { setImportManual(true); setImportMsg(e.body?.stderr || e.message || String(e)); }
    }
  };

  const copyImport = () => { if (importCmd) navigator.clipboard.writeText(importCmd).then(() => { setImportCopied(true); setTimeout(() => setImportCopied(false), 1500); }); };

  const uploadedNames = useMemo(
    () => new Set(manifest.photos.filter((p) => p.source === "upload").map((p) => p.filename)),
    [manifest]
  );

  const doUpload = async (files: File[], mode: "keepboth" | "replace") => {
    setDupe(null);
    setUploading(true);
    try {
      const r = await api.uploadPhotos(slug, files, activeDay, mode);
      await reloadManifest();
      const parts: string[] = [];
      if (r.added) parts.push(`${r.added} added`);
      if (r.replaced) parts.push(`${r.replaced} replaced`);
      if (r.failed) parts.push(`${r.failed} skipped`);
      setToast(`✓ ${parts.join(" · ") || "nothing"} — on Day ${r.dayIndex}`);
    } catch {
      setToast("Upload failed");
    } finally {
      setUploading(false);
      window.setTimeout(() => setToast(null), 4500);
    }
  };

  const handleFiles = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) return;
    const dupes = list.filter((f) => uploadedNames.has(f.name)).length;
    if (dupes > 0) setDupe({ files: list, count: dupes });
    else doUpload(list, "keepboth");
  };

  const chosenByDay = useMemo(() => {
    const counts: Record<number, number> = {};
    manifest.photos.forEach((p) => {
      if (project.photos[p.uuid]?.chosen) counts[p.dayIndex] = (counts[p.dayIndex] || 0) + 1;
    });
    return counts;
  }, [manifest, project]);

  const dayPhotos = useMemo(() => {
    let list = manifest.photos.filter((p) => p.dayIndex === activeDay);
    if (onlyChosen) list = list.filter((p) => project.photos[p.uuid]?.chosen);
    if (hideDupes) {
      const sigOf = (p: Photo) => p.sig || p.uuid;
      const isChosen = (p: Photo) => !!project.photos[p.uuid]?.chosen;
      // never hides chosen photos, and hides duplicates of an already-chosen one
      const seen = new Set(list.filter(isChosen).map(sigOf));
      list = list.filter((p) => {
        if (isChosen(p)) return true;
        const s = sigOf(p);
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
    }
    return list;
  }, [manifest, project, activeDay, onlyChosen, hideDupes]);

  const dupCount = useMemo(() => {
    const all = manifest.photos.filter((p) => p.dayIndex === activeDay);
    const seen = new Set<string>();
    let dupes = 0;
    for (const p of all) {
      const s = p.sig || p.uuid;
      if (seen.has(s)) dupes++;
      else seen.add(s);
    }
    return dupes;
  }, [manifest, activeDay]);

  const activeDayInfo = manifest.days.find((d) => d.index === activeDay);

  // which album sheet (if any) each photo is placed on
  const placedAt = useMemo(() => {
    const map = new Map<string, number>();
    project.album.sheets.forEach((s, i) => {
      [...s.front, ...s.back].forEach((u) => { if (u && !map.has(u)) map.set(u, i + 1); });
    });
    return map;
  }, [project]);

  const requestDelete = (uuid: string) => {
    const ph = manifest.photos.find((p) => p.uuid === uuid);
    setPendingDel({ uuid, filename: ph?.filename || "", sheet: placedAt.get(uuid) ?? null });
  };

  const doDelete = async () => {
    if (!pendingDel) return;
    const { uuid } = pendingDel;
    setPendingDel(null);
    try {
      await api.deletePhoto(slug, uuid);
      setProject((p) => {
        const photos = { ...p.photos };
        delete photos[uuid];
        const sheets = p.album.sheets.map((s) => ({
          front: s.front.map((u) => (u === uuid ? null : u)),
          back: s.back.map((u) => (u === uuid ? null : u)),
        }));
        return { ...p, photos, album: { sheets } };
      });
      await reloadManifest();
      setToast("🗑 Photo deleted");
    } catch {
      setToast("Delete failed");
    } finally {
      window.setTimeout(() => setToast(null), 4000);
    }
  };

  return (
    <div className="curadoria">
      <aside className="timeline">
        <div className="timeline-head">Timeline</div>
        <ul>
          {manifest.days.map((d) => {
            const chosen = chosenByDay[d.index] || 0;
            return (
              <li key={d.index}>
                <button className={d.index === activeDay ? "day on" : "day"} onClick={() => setActiveDay(d.index)}>
                  <span className="day-n">{d.index}</span>
                  <span className="day-meta">
                    <span className="day-label">Day {d.index}</span>
                    <span className="day-date">{fmtDate(d.date)}</span>
                  </span>
                  <span className="day-counts">
                    {chosen > 0 && <span className="chip-chosen">{chosen}</span>}
                    <span className="chip-total">{d.count}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section
        className={dragOver ? "gallery dragover" : "gallery"}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          hidden
          onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }}
        />
        {dragOver && <div className="drop-overlay">Drop photos to add to Day {activeDay}</div>}
        <div className="gallery-head">
          <div>
            <h2>
              Day {activeDay} <span className="muted">· {activeDayInfo && fmtDate(activeDayInfo.date)}</span>
            </h2>
            <p className="muted">
              {dayPhotos.length} {onlyChosen ? "chosen" : "photos"} · {chosenByDay[activeDay] || 0} chosen this day
            </p>
          </div>
          <div className="toggles">
            <button className="btn-upload" onClick={() => fileRef.current?.click()} disabled={uploading} title="Add photos from your computer to this day">
              {uploading ? "Adding…" : "＋ Add photos"}
            </button>
            <button className="btn-import" onClick={() => setShowImport(true)} title="Optional: import from your Apple Photos library">
              Import from Photos
            </button>
            <label className="toggle">
              <input type="checkbox" checked={onlyChosen} onChange={(e) => setOnlyChosen(e.target.checked)} />
              <span>Only chosen</span>
            </label>
            <label className="toggle" title="Hides near-identical photos (same size and dimensions). Never hides a chosen one.">
              <input type="checkbox" checked={hideDupes} onChange={(e) => setHideDupes(e.target.checked)} />
              <span>Hide duplicates{dupCount > 0 ? ` (${dupCount})` : ""}</span>
            </label>
          </div>
        </div>

        {dayPhotos.length === 0 ? (
          <div className="empty-day">No {onlyChosen ? "chosen " : ""}photos on this day.</div>
        ) : (
          <div className="grid">
            {dayPhotos.map((p) => (
              <PhotoCard
                key={p.uuid}
                slug={slug}
                photo={p}
                chosen={!!project.photos[p.uuid]?.chosen}
                caption={project.photos[p.uuid]?.caption || ""}
                onToggle={() => patchPhoto(p.uuid, { chosen: !project.photos[p.uuid]?.chosen })}
                onCaption={(v) => patchPhoto(p.uuid, { caption: v })}
                onOpen={() => setLightbox(p.uuid)}
                onDelete={() => requestDelete(p.uuid)}
              />
            ))}
          </div>
        )}
      </section>

      {lightbox && <Lightbox uuid={lightbox} onClose={() => setLightbox(null)} onNav={setLightbox} photos={dayPhotos} />}

      {pendingDel && (
        <div className="modal-overlay" onClick={() => setPendingDel(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setPendingDel(null)}>✕</button>
            <h2>Delete this photo?</h2>
            {pendingDel.sheet != null ? (
              <p className="warn-line">
                ⚠ It's placed in the album on <b>Sheet {String(pendingDel.sheet).padStart(2, "0")}</b>. Deleting it will
                remove it from the album too.
              </p>
            ) : (
              <p className="muted">This removes it from the catalog{pendingDel.filename ? ` (${pendingDel.filename})` : ""}. This can't be undone.</p>
            )}
            <div className="dupe-actions">
              <button className="btn-danger" onClick={doDelete}>Delete</button>
              <button className="btn-ghost dark" onClick={() => setPendingDel(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="upload-toast">{toast}</div>}

      {showImport && (
        <div className="modal-overlay" onClick={() => !importing && setShowImport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => !importing && setShowImport(false)}>✕</button>
            <h2>Import from Apple Photos</h2>
            <p className="muted">
              Pull photos from your macOS Photos library for this trip's dates ({fmtDate(config.queryFrom || config.startDate)}–{fmtDate(config.queryTo || config.startDate)}).
              Only metadata and previews are read — no images are uploaded anywhere. You can also just use “Add photos”.
            </p>
            <div className="disc-sync-actions">
              <button className="btn-primary" onClick={doImport} disabled={importing}>{importing ? "Importing…" : "Import now"}</button>
              <button className="disc-manual-toggle" onClick={() => setImportManual((v) => !v)}>{importManual ? "hide manual command" : "run it manually"}</button>
            </div>
            {importing && importProg && (
              <div className="disc-prog">
                <div className={`exp-bar${importProg.total > 0 ? "" : " indeterminate"}`}>
                  <div className="exp-fill" style={importProg.total > 0 ? { width: `${Math.round((importProg.done / importProg.total) * 100)}%` } : undefined} />
                </div>
                <div className="disc-prog-label">
                  {importProg.phase === "thumbs" ? "Making thumbnails" : importProg.status}
                  {importProg.total > 0 ? ` · ${importProg.done.toLocaleString()}/${importProg.total.toLocaleString()}` : ""} · {fmtElapsed(importProg.elapsed)}
                </div>
              </div>
            )}
            {importMsg && <p className="err-msg">{importMsg}</p>}
            {importManual && (
              <div className="disc-manual">
                <p className="muted">Run this in your terminal (Full Disk Access), then reload:</p>
                <div className="cmd"><code>{importCmd || "…"}</code><button className="btn-copy" onClick={copyImport}>{importCopied ? "copied ✓" : "copy"}</button></div>
              </div>
            )}
          </div>
        </div>
      )}

      {dupe && (
        <div className="modal-overlay" onClick={() => setDupe(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setDupe(null)}>✕</button>
            <h2>Same name found</h2>
            <p className="muted">
              {dupe.count} of these {dupe.count > 1 ? "photos match names" : "photo matches a name"} you already added to this trip.
              What should happen?
            </p>
            <div className="dupe-actions">
              <button className="btn-primary" onClick={() => doUpload(dupe.files, "keepboth")}>Keep both</button>
              <button className="btn-ghost dark" onClick={() => doUpload(dupe.files, "replace")}>Replace existing</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PhotoCard({
  slug,
  photo,
  chosen,
  caption,
  onToggle,
  onCaption,
  onOpen,
  onDelete,
}: {
  slug: string;
  photo: Photo;
  chosen: boolean;
  caption: string;
  onToggle: () => void;
  onCaption: (v: string) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <figure className={chosen ? "card chosen" : "card"}>
      <div className="card-img" onClick={onOpen}>
        {photo.hasThumb ? (
          <img src={thumbUrl(slug, photo.uuid)} loading="lazy" alt={photo.filename} draggable={false} />
        ) : (
          <div className="no-thumb">no thumbnail</div>
        )}
        <button
          className="del"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete photo"
          aria-label="Delete photo"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M9 3h6l1 2h4v2H4V5h4l1-2z" />
            <path d="M6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8z" />
          </svg>
        </button>
        <button
          className={chosen ? "pick on" : "pick"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title={chosen ? "Remove from album" : "Choose for the album"}
        >
          {chosen ? "★" : "☆"}
        </button>
      </div>
      {chosen && (
        <textarea
          className="caption-input"
          placeholder="Write what happened here…"
          value={caption}
          onChange={(e) => onCaption(e.target.value)}
          rows={2}
        />
      )}
    </figure>
  );
}
