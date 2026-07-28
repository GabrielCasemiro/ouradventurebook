import { useEffect } from "react";
import { useApp } from "../App";
import { thumbUrl } from "../lib/api";
import type { Photo } from "../lib/types";

export function Lightbox({
  uuid,
  photos,
  onClose,
  onNav,
}: {
  uuid: string;
  photos: Photo[];
  onClose: () => void;
  onNav: (uuid: string) => void;
}) {
  const { slug, project, patchPhoto, photosByUuid } = useApp();
  const photo = photosByUuid.get(uuid);
  const idx = photos.findIndex((p) => p.uuid === uuid);

  const go = (delta: number) => {
    const n = idx + delta;
    if (n >= 0 && n < photos.length) onNav(photos[n].uuid);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT";
      if (e.key === "Escape") (document.activeElement as HTMLElement)?.blur?.(), onClose();
      else if (!typing && e.key === "ArrowLeft") go(-1);
      else if (!typing && e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, photos]);

  if (!photo) return null;
  const st = project.photos[uuid] || {};
  const chosen = !!st.chosen;

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lb-close" onClick={onClose}>
        ✕
      </button>
      {idx > 0 && (
        <button className="lb-nav left" onClick={(e) => (e.stopPropagation(), go(-1))}>
          ‹
        </button>
      )}
      {idx < photos.length - 1 && (
        <button className="lb-nav right" onClick={(e) => (e.stopPropagation(), go(1))}>
          ›
        </button>
      )}

      <div className="lb-stage" onClick={(e) => e.stopPropagation()}>
        <div className="lb-imgwrap">
          {photo.hasThumb ? (
            <img src={thumbUrl(slug, uuid)} alt={photo.filename} />
          ) : (
            <div className="no-thumb big">no thumbnail</div>
          )}
        </div>
        <div className="lb-side">
          <div className="lb-meta">
            <span className="muted">{photo.filename}</span>
            <span className="muted">Day {photo.dayIndex}</span>
          </div>
          <button className={chosen ? "btn-choose on" : "btn-choose"} onClick={() => patchPhoto(uuid, { chosen: !chosen })}>
            {chosen ? "★ Chosen" : "☆ Choose for the album"}
          </button>
          <label className="lb-caplabel">Caption</label>
          <textarea
            className="lb-caption"
            placeholder="What happened in this photo…"
            value={st.caption || ""}
            onChange={(e) => patchPhoto(uuid, { caption: e.target.value })}
          />
          <p className="lb-hint">← → to navigate · Esc to close</p>
        </div>
      </div>
    </div>
  );
}
