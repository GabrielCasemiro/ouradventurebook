import { useEffect, useState } from "react";
import { useApp } from "../App";
import { api, thumbUrl, videoUrl } from "../lib/api";
import type { Photo } from "../lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDateTime = (iso: string) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const t = iso.slice(11, 16);
  return `${d} ${MONTHS[m - 1]} ${y}${t ? " · " + t : ""}`;
};
const fmtShutter = (s?: number) => (s ? (s < 1 ? `1/${Math.round(1 / s)}s` : `${s}s`) : null);
const fmtSize = (b?: number) => (!b ? null : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

function Details({ photo }: { photo: Photo }) {
  const m = photo.meta || {};
  const rows: [string, string][] = [];
  if (photo.date) rows.push(["Taken", fmtDateTime(photo.date)]);
  if (photo.width && photo.height) rows.push(["Size", `${photo.width} × ${photo.height}`]);
  if (m.camera) rows.push(["Camera", m.camera]);
  if (m.lens) rows.push(["Lens", m.lens]);
  const exp = [
    m.aperture && `ƒ/${m.aperture}`,
    m.focalLength && `${Math.round(m.focalLength)}mm`,
    m.iso && `ISO ${m.iso}`,
    fmtShutter(m.shutter),
  ].filter(Boolean).join(" · ");
  if (exp) rows.push(["Exposure", exp]);
  if (m.filesize) rows.push(["File", fmtSize(m.filesize)!]);

  const hasGeo = m.lat != null && m.lng != null;
  const d = 0.008;
  const bbox = hasGeo ? `${m.lng! - d},${m.lat! - d},${m.lng! + d},${m.lat! + d}` : "";

  return (
    <>
      <dl className="lb-details">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {hasGeo && (
          <div>
            <dt>Location</dt>
            <dd>
              <a href={`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=15/${m.lat}/${m.lng}`} target="_blank" rel="noreferrer">
                📍 {m.lat!.toFixed(4)}, {m.lng!.toFixed(4)}
              </a>
            </dd>
          </div>
        )}
      </dl>
      {hasGeo && (
        <iframe
          className="lb-map"
          title="Location map"
          loading="lazy"
          src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${m.lat},${m.lng}`}
        />
      )}
    </>
  );
}

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
          {photo.type === "video" ? (
            <VideoView slug={slug} photo={photo} />
          ) : photo.hasThumb ? (
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
          <Details photo={photo} />
          <p className="lb-hint">← → to navigate · Esc to close</p>
        </div>
      </div>
    </div>
  );
}

// A video plays right here in the editor. If its web render doesn't exist yet,
// clicking ▶ transcodes it on demand and then plays it. It only can't play when
// the original isn't on this Mac (e.g. still in iCloud) — then we say so plainly.
type VideoStatus = "idle" | "preparing" | "ready" | "error";
function VideoView({ slug, photo }: { slug: string; photo: Photo }) {
  const { uuid } = photo;
  const poster = photo.hasThumb ? thumbUrl(slug, uuid) : undefined;
  const [status, setStatus] = useState<VideoStatus>(photo.hasVideo ? "ready" : "idle");
  const [autoplay, setAutoplay] = useState(false);

  // reset when navigating to another item in the lightbox
  useEffect(() => {
    setStatus(photo.hasVideo ? "ready" : "idle");
    setAutoplay(false);
  }, [uuid, photo.hasVideo]);

  const prepareAndPlay = async () => {
    setStatus("preparing");
    try {
      const r = await api.prepareVideo(slug, uuid);
      if (r.ready) { setAutoplay(true); setStatus("ready"); }
      else setStatus("error");
    } catch {
      setStatus("error");
    }
  };

  if (status === "ready") {
    return (
      <video
        className="lb-video"
        src={videoUrl(slug, uuid)}
        poster={poster}
        controls
        autoPlay={autoplay}
        playsInline
        // metadata (not none) so a paused video still shows a frame + the native
        // play button instead of an empty black box; it won't play until clicked
        preload={autoplay ? "auto" : "metadata"}
      />
    );
  }

  return (
    <div className="lb-vidpending">
      {poster && <img src={poster} alt={photo.filename} />}
      {status === "preparing" ? (
        <span className="lb-vidbadge">Preparing video…</span>
      ) : status === "error" ? (
        <span className="lb-vidbadge">
          Can't play this video yet — its original isn't on this Mac. Download it in Photos (or run Export), then try again.
        </span>
      ) : (
        <button className="lb-playbtn" onClick={prepareAndPlay} aria-label="Play video" title="Play video">▶</button>
      )}
    </div>
  );
}
