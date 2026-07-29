import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../App";
import { api, thumbUrl } from "../lib/api";
import type { Carousel, Social as SocialData, SocialFormat } from "../lib/types";

const FORMATS: { key: SocialFormat; label: string; ratio: string }[] = [
  { key: "4x5", label: "Feed 4:5", ratio: "4 / 5" },
  { key: "1x1", label: "Square", ratio: "1 / 1" },
  { key: "9x16", label: "Story 9:16", ratio: "9 / 16" },
];
const RATIO: Record<SocialFormat, string> = { "4x5": "4 / 5", "1x1": "1 / 1", "9x16": "9 / 16" };

const BACKGROUNDS: { value: string; label: string; css?: string }[] = [
  { value: "blur", label: "Blur" },
  { value: "FFFFFF", label: "White", css: "#FFFFFF" },
  { value: "FBF6EA", label: "Cream", css: "#FBF6EA" },
  { value: "12307A", label: "Blue", css: "#12307A" },
  { value: "000000", label: "Black", css: "#000000" },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fmtDay = (iso: string) => {
  if (!iso) return "";
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m || 1) - 1]}`;
};

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

const newCarousel = (n: number): Carousel => ({
  id: uid(),
  title: `Post ${n}`,
  format: "4x5",
  background: "blur",
  slides: [],
  caption: "",
});

export function Social({ goCuradoria }: { goCuradoria: () => void }) {
  const { slug, chosenSorted } = useApp();
  const [social, setSocial] = useState<SocialData | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [posting, setPosting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    api.getSocial(slug).then((s) => {
      setSocial(s);
      setSelId(s.carousels[0]?.id ?? null);
    }).catch(() => setSocial({ carousels: [] }));
  }, [slug]);

  const persist = useCallback(async (next: SocialData) => {
    setSaveStatus("saving");
    try { await api.putSocial(slug, next); setSaveStatus("saved"); setDirty(false); }
    catch { setSaveStatus("error"); }
  }, [slug]);

  const save = useCallback((next: SocialData) => {
    setDirty(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => persist(next), 700);
  }, [persist]);

  const flushSave = () => {
    if (!social) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    persist(social);
  };

  const mutate = useCallback((fn: (cs: Carousel[]) => Carousel[]) => {
    setSocial((prev) => {
      if (!prev) return prev;
      const next = { ...prev, carousels: fn(prev.carousels) };
      save(next);
      return next;
    });
  }, [save]);

  const patchSel = (patch: Partial<Carousel>) =>
    mutate((cs) => cs.map((c) => (c.id === selId ? { ...c, ...patch } : c)));

  const addCarousel = () => {
    setSocial((prev) => {
      const base = prev ?? { carousels: [] };
      const c = newCarousel(base.carousels.length + 1);
      const next = { ...base, carousels: [...base.carousels, c] };
      save(next);
      setSelId(c.id);
      return next;
    });
  };

  const removeCarousel = (id: string) =>
    mutate((cs) => {
      const rest = cs.filter((c) => c.id !== id);
      if (id === selId) setSelId(rest[0]?.id ?? null);
      return rest;
    });

  if (!social) return <div className="splash"><div className="splash-star">✦</div><p>Opening…</p></div>;

  const sel = social.carousels.find((c) => c.id === selId) || null;
  const tray = sel ? chosenSorted.filter((p) => !sel.slides.includes(p.uuid)) : [];
  // group the tray by day (chosenSorted is already in chronological order)
  const trayDays: { day: number; date: string; items: typeof tray }[] = [];
  for (const p of tray) {
    let g = trayDays[trayDays.length - 1];
    if (!g || g.day !== p.dayIndex) { g = { day: p.dayIndex, date: p.date, items: [] }; trayDays.push(g); }
    g.items.push(p);
  }

  const addSlide = (uuid: string) => patchSel({ slides: [...(sel?.slides || []), uuid] });
  const removeSlide = (i: number) => patchSel({ slides: (sel?.slides || []).filter((_, idx) => idx !== i) });
  const moveSlide = (from: number, to: number) => {
    if (!sel || from === to) return;
    const s = [...sel.slides];
    const [m] = s.splice(from, 1);
    s.splice(to, 0, m);
    patchSel({ slides: s });
  };

  const copyCaption = () => sel?.caption && navigator.clipboard.writeText(sel.caption);

  const doExport = async () => {
    if (!sel) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const r = await api.exportSocial(slug, sel.id);
      setExportMsg(`Saved to ${r.folder || r.dir}/`);
    } catch (e: any) {
      setExportMsg(`Error: ${e.body?.stderr || e.message || e}`);
    } finally {
      setExporting(false);
    }
  };

  const postToInstagram = async () => {
    if (!sel || sel.slides.length === 0) return;
    // gesture-bound steps first so the browser does not block them
    if (sel.caption.trim()) navigator.clipboard.writeText(sel.caption).catch(() => {});
    window.open("https://www.instagram.com/", "_blank", "noopener");
    setPosting(true);
    setExportMsg(null);
    try {
      if (dirty) await api.putSocial(slug, social);
      await api.exportSocial(slug, sel.id);
      try { await api.revealSocial(slug, sel.id); } catch {}
      const n = sel.slides.length;
      setExportMsg(`${n} slide${n === 1 ? "" : "s"} exported and the folder opened. Caption copied. In the Instagram tab, start a new post, drag the slides in order and paste the caption.`);
    } catch (e: any) {
      setExportMsg(`Error: ${e.body?.stderr || e.message || e}`);
    } finally {
      setPosting(false);
    }
  };

  const bgStyle = (bg: string): React.CSSProperties =>
    bg === "blur" ? {} : { backgroundColor: `#${bg}` };

  if (chosenSorted.length === 0) {
    return (
      <div className="social">
        <div className="social-empty">
          <div className="splash-star">✦</div>
          <h2>No photos chosen yet</h2>
          <p>Pick photos in <button className="link" onClick={goCuradoria}>Curate</button> first, then build carousels from them here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="social">
      <aside className="social-list">
        <div className="social-list-head">
          <span>Carousels</span>
        </div>
        {social.carousels.map((c) => (
          <button
            key={c.id}
            className={c.id === selId ? "social-item on" : "social-item"}
            onClick={() => setSelId(c.id)}
          >
            <span className="social-item-thumb" style={bgStyle(c.background)}>
              {c.slides[0] ? <img src={thumbUrl(slug, c.slides[0])} alt="" /> : <span className="social-item-empty">＋</span>}
            </span>
            <span className="social-item-meta">
              <span className="social-item-title">{c.title || "Untitled"}</span>
              <span className="social-item-sub">{c.format} · {c.slides.length} slide{c.slides.length === 1 ? "" : "s"}</span>
            </span>
            <span className="social-item-del" onClick={(e) => { e.stopPropagation(); removeCarousel(c.id); }} title="Delete carousel">✕</span>
          </button>
        ))}
        <button className="social-new" onClick={addCarousel}>＋ New carousel</button>
      </aside>

      {sel ? (
        <section className="social-editor">
          <div className="social-editor-head">
            <input
              className="social-title-input"
              value={sel.title}
              placeholder="Post title (for your reference)"
              onChange={(e) => patchSel({ title: e.target.value })}
            />
            <button
              className={`social-save${dirty ? " dirty" : ""}`}
              onClick={flushSave}
              disabled={saveStatus === "saving"}
              title="Changes save automatically; click to save now"
            >
              {saveStatus === "saving" ? "Saving…" : dirty ? "Save" : "Saved ✓"}
            </button>
            <button className="btn-ghost sm dark" onClick={doExport} disabled={exporting || posting || sel.slides.length === 0}>
              {exporting ? "Exporting…" : "Export"}
            </button>
            <button className="social-ig" onClick={postToInstagram} disabled={posting || exporting || sel.slides.length === 0}>
              {posting ? "Preparing…" : "Post to Instagram"}
            </button>
          </div>
          {exportMsg && <p className="social-export-msg">{exportMsg}</p>}

          <div className="social-controls">
            <div className="social-ctrl">
              <span className="social-ctrl-label">Format</span>
              <div className="social-seg">
                {FORMATS.map((f) => (
                  <button key={f.key} className={sel.format === f.key ? "on" : ""} onClick={() => patchSel({ format: f.key })}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="social-ctrl">
              <span className="social-ctrl-label">Background</span>
              <div className="social-bgs">
                {BACKGROUNDS.map((b) => (
                  <button
                    key={b.value}
                    className={`social-bg${sel.background === b.value ? " on" : ""}${b.value === "blur" ? " blur" : ""}`}
                    style={b.css ? { background: b.css } : undefined}
                    onClick={() => patchSel({ background: b.value })}
                    title={b.label}
                  >
                    {b.value === "blur" ? "≈" : ""}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="social-slides-wrap">
            <div className="social-section-label">Slides · drag to reorder</div>
            <div className="social-slides">
              {sel.slides.map((uuid, i) => (
                <figure
                  key={`${uuid}-${i}`}
                  className={`social-slide${drag === i ? " dragging" : ""}`}
                  style={{ aspectRatio: RATIO[sel.format] }}
                  draggable
                  onDragStart={() => setDrag(i)}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (drag !== null) moveSlide(drag, i); setDrag(null); }}
                >
                  <div className="social-canvas" style={bgStyle(sel.background)}>
                    {sel.background === "blur" && <img className="social-canvas-blur" src={thumbUrl(slug, uuid)} alt="" />}
                    <img className="social-canvas-photo" src={thumbUrl(slug, uuid)} alt="" draggable={false} />
                  </div>
                  <span className="social-slide-n">{i + 1}</span>
                  <button className="social-slide-x" onClick={() => removeSlide(i)} title="Remove slide">✕</button>
                </figure>
              ))}
              {sel.slides.length === 0 && <div className="social-slides-empty">Add photos from below →</div>}
            </div>
          </div>

          <div className="social-caption-wrap">
            <div className="social-section-label">
              Caption
              <button className="social-copy" onClick={copyCaption} disabled={!sel.caption.trim()}>copy</button>
            </div>
            <textarea
              className="social-caption"
              placeholder="Write your post caption and hashtags…"
              value={sel.caption}
              onChange={(e) => patchSel({ caption: e.target.value })}
            />
          </div>

          <div className="social-tray">
            <div className="social-section-label">
              {tray.length > 0 ? `${tray.length} chosen photo${tray.length === 1 ? "" : "s"} — click to add` : "All chosen photos are in this carousel"}
            </div>
            <div className="social-tray-days">
              {trayDays.map((g) => (
                <div className="social-tray-day" key={g.day}>
                  <div className="social-tray-day-label">
                    <span className="social-tray-day-n">Day {g.day}</span>
                    <span className="social-tray-day-date">{fmtDay(g.date)}</span>
                    <span className="social-tray-day-count">{g.items.length}</span>
                  </div>
                  <div className="social-tray-strip">
                    {g.items.map((p) => (
                      <button key={p.uuid} className="social-tray-thumb" onClick={() => addSlide(p.uuid)} title={`Day ${p.dayIndex} · add`}>
                        <img src={thumbUrl(slug, p.uuid)} loading="lazy" alt="" />
                        <span className="social-tray-add">＋</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <section className="social-editor social-editor-empty">
          <div className="splash-star">✦</div>
          <h2>Create your first carousel</h2>
          <p>Group photos into a post, pick a format and background, then export slides ready to upload.</p>
          <button className="btn-primary" onClick={addCarousel}>＋ New carousel</button>
        </section>
      )}
    </div>
  );
}
