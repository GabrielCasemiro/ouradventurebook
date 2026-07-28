import { useMemo, useRef, useState } from "react";
import { useApp } from "../App";
import { api } from "../lib/api";
import { thumbUrl } from "../lib/api";
import type { Photo } from "../lib/types";
import { Lightbox } from "../components/Lightbox";

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}`;
};

export function Curadoria({
  activeDay,
  setActiveDay,
}: {
  activeDay: number;
  setActiveDay: (d: number) => void;
}) {
  const { slug, manifest, project, patchPhoto, reloadManifest } = useApp();
  const [onlyChosen, setOnlyChosen] = useState(false);
  const [hideDupes, setHideDupes] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    setUploading(true);
    try {
      await api.uploadPhotos(slug, list, activeDay);
      await reloadManifest();
    } finally {
      setUploading(false);
    }
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
          accept="image/*"
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
              />
            ))}
          </div>
        )}
      </section>

      {lightbox && <Lightbox uuid={lightbox} onClose={() => setLightbox(null)} onNav={setLightbox} photos={dayPhotos} />}
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
}: {
  slug: string;
  photo: Photo;
  chosen: boolean;
  caption: string;
  onToggle: () => void;
  onCaption: (v: string) => void;
  onOpen: () => void;
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
