import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, photoUrl } from "../lib/api";
import type { Manifest, Project, Photo, TripConfig } from "../lib/types";
import { iterateSlots, getSlot } from "../lib/album";
import { Music } from "./Music";
import { TripMap, type MapPoint } from "./TripMap";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const fmtLong = (iso: string) => {
  if (!iso) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

const SlugCtx = createContext<string>("");
const useSlug = () => useContext(SlugCtx);

export interface StoryItem { uuid: string; photo: Photo; caption: string; dayIndex: number; }
interface DaySection { dayIndex: number; date: string; items: StoryItem[]; }

export function Story({ slug }: { slug: string }) {
  const [config, setConfig] = useState<TripConfig | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(1);
  const [hdDismissed, setHdDismissed] = useState(false);

  useEffect(() => {
    api.config(slug).then(setConfig).catch((e) => setErr(String(e.message || e)));
    Promise.all([api.manifest(slug), api.getProject(slug)])
      .then(([m, p]) => { setManifest(m); setProject(p); })
      .catch((e) => setErr(e.body?.error === "manifest_missing" ? "This album has no imported photos yet." : String(e.message || e)));
  }, [slug]);

  const data = useMemo(() => {
    if (!manifest || !project) return null;
    const byUuid = new Map(manifest.photos.map((p) => [p.uuid, p]));
    const ordered: StoryItem[] = [];
    for (const ref of iterateSlots(project.album.sheets.length)) {
      const uuid = getSlot(project.album.sheets, ref);
      if (!uuid) continue;
      const photo = byUuid.get(uuid);
      if (!photo) continue;
      ordered.push({ uuid, photo, caption: project.photos[uuid]?.caption || "", dayIndex: photo.dayIndex });
    }
    const sections: DaySection[] = [];
    for (const it of ordered) {
      let sec = sections[sections.length - 1];
      if (!sec || sec.dayIndex !== it.dayIndex) {
        sec = { dayIndex: it.dayIndex, date: manifest.days.find((d) => d.index === it.dayIndex)?.date || "", items: [] };
        sections.push(sec);
      }
      sec.items.push(it);
    }
    const daysPresent = sections.map((s) => ({ dayIndex: s.dayIndex, date: s.date }));
    const cover =
      ordered.find((i) => i.photo.isFavorite && i.photo.width > i.photo.height)?.photo ||
      ordered.find((i) => i.photo.width > i.photo.height)?.photo || ordered[0]?.photo || null;
    const stats = { dias: sections.length, fotos: ordered.length, legendas: ordered.filter((i) => i.caption.trim()).length };
    const missingHd = ordered.filter((i) => !i.photo.hd).length;
    const mapPoints: MapPoint[] = ordered
      .filter((i) => i.photo.meta?.lat != null && i.photo.meta?.lng != null)
      .map((i) => ({ lat: i.photo.meta!.lat!, lng: i.photo.meta!.lng!, uuid: i.uuid, caption: i.caption, dayIndex: i.dayIndex }));
    return { sections, daysPresent, cover, stats, mapPoints, missingHd };
  }, [manifest, project]);

  if (err) return <div className="story-loading">{err}</div>;
  if (!config || !manifest || !project || !data) return <div className="story-loading"><span className="splash-star">✦</span></div>;

  const { sections, daysPresent, cover, stats, mapPoints, missingHd } = data;
  const start = manifest.trip.startDate;
  const lastDate = sections.length ? sections[sections.length - 1].date : manifest.days[manifest.days.length - 1].date;
  const dateRange = `${fmtLong(start)} — ${fmtLong(lastDate)}, ${start.slice(0, 4)}`;

  const goToDay = (n: number) => {
    const el = document.getElementById(`day-${n}`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 58, behavior: "auto" });
  };

  return (
    <SlugCtx.Provider value={slug}>
      <div className="story">
        <Sparkles />
        {config.music && <Music videoId={config.music} />}
        <FloatingHeader emoji={config.emoji} days={daysPresent} activeDay={activeDay} onDay={goToDay} />
        {missingHd > 0 && !hdDismissed && (
          <div className="hd-notice" role="status">
            <span className="hd-notice-dot" aria-hidden="true">✦</span>
            <span className="hd-notice-text">
              Showing low-res previews — {missingHd} photo{missingHd > 1 ? "s aren’t" : " isn’t"} in high resolution yet.
              Open the <a href={`/trip/${slug}`}>editor</a>, run <strong>Export</strong> and click <strong>“I ran it — finish”</strong> to bring in the HD versions.
            </span>
            <button className="hd-notice-x" onClick={() => setHdDismissed(true)} aria-label="Dismiss">✕</button>
          </div>
        )}
        <Cover config={config} cover={cover} dateRange={dateRange} stats={stats} />
        {mapPoints.length > 0 && (
          <section className="story-mapsection">
            <div className="story-maphead">
              <div className="story-kicker">everywhere we went</div>
              <h2 className="story-maptitle">{mapPoints.length} moments on the map</h2>
            </div>
            <TripMap slug={slug} points={mapPoints} days={config.days} />
          </section>
        )}
        {sections.map((sec) => <DaySectionView key={sec.dayIndex} section={sec} onActive={setActiveDay} />)}
        <footer className="story-end">
          <div className="splash-star">✦</div>
          <h2>{stats.dias} unforgettable days.</h2>
          <p>{stats.fotos} memories to keep forever.</p>
          <div className="story-end-castle">{config.emoji || "✦"}</div>
        </footer>
      </div>
    </SlugCtx.Provider>
  );
}

function FloatingHeader({ emoji, days, activeDay, onDay }: { emoji?: string; days: { dayIndex: number; date: string }[]; activeDay: number; onDay: (n: number) => void; }) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }, [activeDay]);
  return (
    <header className="fh">
      <a className="fh-brand" href="/" title="All trips">{emoji || "✦"}</a>
      <nav className="fh-days">
        {days.map((d) => (
          <button key={d.dayIndex} ref={d.dayIndex === activeDay ? activeRef : undefined}
            className={d.dayIndex === activeDay ? "fh-pill on" : "fh-pill"} onClick={() => onDay(d.dayIndex)} title={fmtLong(d.date)}>
            {d.dayIndex}
          </button>
        ))}
      </nav>
    </header>
  );
}

const SPARKLES = [
  { top: "12%", left: "8%", d: "0s", dur: "5.5s", s: 3 }, { top: "22%", left: "82%", d: "1.2s", dur: "6.5s", s: 2 },
  { top: "38%", left: "20%", d: "2.1s", dur: "5s", s: 4 }, { top: "51%", left: "70%", d: "0.6s", dur: "7s", s: 2 },
  { top: "63%", left: "12%", d: "3s", dur: "6s", s: 3 }, { top: "72%", left: "88%", d: "1.8s", dur: "5.2s", s: 2 },
  { top: "30%", left: "50%", d: "2.6s", dur: "6.8s", s: 3 }, { top: "84%", left: "40%", d: "0.9s", dur: "5.6s", s: 2 },
  { top: "45%", left: "94%", d: "3.4s", dur: "6.2s", s: 3 }, { top: "18%", left: "36%", d: "1.5s", dur: "7.4s", s: 2 },
  { top: "58%", left: "58%", d: "2.9s", dur: "5.8s", s: 4 }, { top: "90%", left: "76%", d: "0.4s", dur: "6.6s", s: 2 },
];
function Sparkles() {
  return (
    <div className="story-sparkles" aria-hidden="true">
      {SPARKLES.map((s, i) => <span key={i} className="sparkle" style={{ top: s.top, left: s.left, animationDelay: s.d, animationDuration: s.dur, width: s.s, height: s.s }} />)}
    </div>
  );
}

function Cover({ config, cover, dateRange, stats }: { config: TripConfig; cover: Photo | null; dateRange: string; stats: any }) {
  const slug = useSlug();
  const ref = useReveal<HTMLDivElement>();
  const bgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (bgRef.current) bgRef.current.style.transform = `translate3d(0, ${window.scrollY * 0.35}px, 0)`; }); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, []);
  return (
    <header className="story-cover">
      <div className="story-cover-bgwrap" ref={bgRef}>{cover && <img className="story-cover-bg" src={photoUrl(slug, cover.uuid)} alt="" />}</div>
      <div className="story-cover-veil" />
      <div className="story-cover-content reveal" ref={ref}>
        {config.kicker && <div className="story-kicker">{config.kicker}</div>}
        <h1 className="story-title">{config.title}</h1>
        <div className="story-daterange">{dateRange}</div>
        <div className="story-stats">
          <Stat n={stats.dias} label="days" /><Stat n={stats.fotos} label="moments" /><Stat n={stats.legendas} label="stories" />
        </div>
        <div className="story-scroll">scroll to begin ↓</div>
      </div>
    </header>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return <div className="story-stat"><span className="story-stat-n">{n}</span><span className="story-stat-l">{label}</span></div>;
}

function DaySectionView({ section, onActive }: { section: DaySection; onActive: (n: number) => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && onActive(section.dayIndex)), { rootMargin: "-45% 0px -45% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [section.dayIndex]);
  return (
    <section className="story-day" id={`day-${section.dayIndex}`} ref={ref}>
      <span className="story-day-watermark" aria-hidden="true">{section.dayIndex}</span>
      <DayMarker index={section.dayIndex} date={section.date} />
      <div className="story-photos">{section.items.map((it) => <StoryPhoto key={it.uuid} item={it} />)}</div>
    </section>
  );
}

function DayMarker({ index, date }: { index: number; date: string }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="story-daymarker reveal" ref={ref}>
      <span className="story-dayline" />
      <div className="story-daynum"><span className="story-daynum-label">Day</span><span className="story-daynum-n">{index}</span></div>
      <span className="story-daydate">{fmtLong(date)}</span>
      <span className="story-dayline" />
    </div>
  );
}

function StoryPhoto({ item }: { item: StoryItem }) {
  const slug = useSlug();
  const ref = useReveal<HTMLElement>();
  const portrait = item.photo.height > item.photo.width;
  return (
    <figure className={`story-photo reveal ${portrait ? "portrait" : "landscape"}`} ref={ref}>
      <div className="story-photo-frame"><img src={photoUrl(slug, item.uuid)} loading="lazy" alt={item.caption || item.photo.filename} /></div>
      {item.caption.trim() && <figcaption>{item.caption}</figcaption>}
    </figure>
  );
}

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}
