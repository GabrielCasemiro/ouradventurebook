import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { TripSummary } from "../lib/types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fmt = (iso: string) => { if (!iso) return ""; const [, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
const addDay = (iso: string) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1);

export function Home() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => { api.trips().then(setTrips).catch((e) => setErr(String(e.message || e))); }, []);

  const groups = useMemo(() => {
    if (!trips) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const withDates = trips.map((t) => {
      const startMs = Date.parse(t.startDate + "T00:00:00");
      return { trip: t, startMs, endMs: startMs + (t.days - 1) * 86400000, year: t.startDate.slice(0, 4) };
    });
    const upcoming = withDates.filter((t) => t.endMs >= todayMs).sort((a, b) => a.startMs - b.startMs);
    const past = withDates.filter((t) => t.endMs < todayMs).sort((a, b) => b.startMs - a.startMs);
    const years = [...new Set(past.map((t) => t.year))].sort().reverse();
    return { upcoming, past, years, todayMs };
  }, [trips]);

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-brand"><span className="home-star">✦</span> OurAdventureBook</div>
        <p className="home-sub">Every trip, its own story — from prints to a photobook.</p>
        <button className="btn-gold home-new" onClick={() => setShowNew(true)}>＋ New trip</button>
      </header>

      {err && <p className="err-msg" style={{ textAlign: "center" }}>{err}</p>}

      {groups && trips!.length === 0 && (
        <button className="trip-card new solo" onClick={() => setShowNew(true)}>
          <span className="trip-new-plus">＋</span>
          <span>Create your first trip</span>
        </button>
      )}

      {groups && groups.upcoming.length > 0 && (
        <section className="home-section">
          <h2 className="home-section-title">Upcoming</h2>
          <div className="trip-grid">
            {groups.upcoming.map((t) => <TripCard key={t.trip.slug} trip={t.trip} startMs={t.startMs} todayMs={groups.todayMs} />)}
          </div>
        </section>
      )}

      {groups && groups.years.map((year) => (
        <section className="home-section" key={year}>
          <h2 className="home-section-title">{year}</h2>
          <div className="trip-grid">
            {groups.past.filter((t) => t.year === year).map((t) => <TripCard key={t.trip.slug} trip={t.trip} />)}
          </div>
        </section>
      ))}

      {showNew && <NewTrip onClose={() => setShowNew(false)} />}
    </div>
  );
}

function TripCard({ trip, startMs, todayMs }: { trip: TripSummary; startMs?: number; todayMs?: number }) {
  const range = `${fmt(trip.startDate)} — ${fmt(new Date(Date.parse(trip.startDate) + (trip.days - 1) * 86400000).toISOString().slice(0, 10))}`;
  let upcomingNote: string | null = null;
  if (startMs != null && todayMs != null) {
    const days = Math.round((startMs - todayMs) / 86400000);
    upcomingNote = days > 0 ? `in ${days} day${days > 1 ? "s" : ""}` : "happening now";
  }
  return (
    <a className="trip-card" href={`/trip/${trip.slug}`}>
      {upcomingNote && <span className="trip-soon">{upcomingNote}</span>}
      <div className="trip-emoji">{trip.emoji || "✦"}</div>
      <div className="trip-title">{trip.title}</div>
      {trip.kicker && <div className="trip-kicker">{trip.kicker}</div>}
      <div className="trip-range">{range} · {trip.days} days</div>
      <div className="trip-stats">
        {trip.hasPhotos ? (
          <><span className="tchip gold">{trip.chosen} chosen</span><span className="tchip">{trip.placed} in album</span></>
        ) : (
          <span className="tchip empty">no photos yet</span>
        )}
      </div>
    </a>
  );
}

function NewTrip({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [kicker, setKicker] = useState("");
  const [emoji, setEmoji] = useState("✦");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [sheets, setSheets] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const slug = useMemo(() => (title && start ? `${slugify(title)}-${start.slice(0, 4)}` : ""), [title, start]);
  const valid = title && start && end && Date.parse(end) >= Date.parse(start) && slug;

  const create = async () => {
    if (!valid) return;
    setBusy(true); setErr(null);
    try {
      const days = daysBetween(start, end);
      const r = await api.createTrip({ slug, title, kicker, emoji, startDate: start, days, sheets, queryFrom: start, queryTo: addDay(end) });
      window.location.href = `/trip/${r.trip.slug}`;
    } catch (e: any) {
      setErr(e.body?.error === "slug_exists" ? "A trip with this name/year already exists." : e.message || String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>New trip</h2>
        <div className="nt-grid">
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Our story in…" /></label>
          <label>Subtitle (place)<input value={kicker} onChange={(e) => setKicker(e.target.value)} placeholder="Chile" /></label>
          <label>Emoji<input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} /></label>
          <label>Album sheets<input type="number" min={1} max={200} value={sheets} onChange={(e) => setSheets(+e.target.value)} /></label>
          <label>Start<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label>End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        {slug && <p className="nt-slug">address: <code>/trip/{slug}</code></p>}
        {err && <p className="err-msg">{err}</p>}
        <div className="modal-foot">
          <button className="btn-primary" onClick={create} disabled={!valid || busy}>{busy ? "creating…" : "Create trip"}</button>
        </div>
      </div>
    </div>
  );
}
