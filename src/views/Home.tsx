import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { DiscoveryInfo, DiscoveryResult, DiscoverySuggestion, TripSummary } from "../lib/types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fmt = (iso: string) => { if (!iso) return ""; const [, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
const addDay = (iso: string) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1);
const fmtElapsed = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function Home() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);

  const reload = () => api.trips().then(setTrips).catch((e) => setErr(String(e.message || e)));
  useEffect(() => { reload(); }, []);

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
        <div className="home-actions">
          <button className="btn-ghost home-discover" onClick={() => setShowDiscover(true)}>✨ Discover from photos</button>
          <button className="btn-gold home-new" onClick={() => setShowNew(true)}>＋ New trip</button>
        </div>
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
      {showDiscover && <DiscoverTrips onClose={() => setShowDiscover(false)} onCreated={reload} />}
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

function DiscoverTrips({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [info, setInfo] = useState<DiscoveryInfo | null>(null);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; status: string; sizeMB: number; elapsed: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<Record<string, "done" | "busy" | string>>({});
  const [creatingAll, setCreatingAll] = useState(false);

  useEffect(() => {
    api.getDiscovery().then((i) => {
      setInfo(i);
      if (i.hasLibrary) analyze(i.settings.homeKey);
    }).catch((e) => setMsg(String(e.message || e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analyze = async (homeKey?: string | null) => {
    setAnalyzing(true); setMsg(null);
    try { setResult(await api.analyzeDiscovery(homeKey)); }
    catch (e: any) { setMsg(e.body?.error === "no_library" ? "No synced library yet — run the command above first." : (e.message || String(e))); }
    finally { setAnalyzing(false); }
  };

  const setRange = async (from: string, to: string) => {
    const r = await api.putDiscovery({ from, to });
    setInfo((prev) => (prev ? { ...prev, settings: r.settings, command: r.command } : prev));
  };

  const syncNow = async () => {
    setSyncing(true); setMsg(null);
    setProg({ done: 0, total: 0, status: "Starting…", sizeMB: 0, elapsed: 0 });
    const poll = window.setInterval(async () => {
      try { const p = await api.syncProgress(); if (p.running) setProg({ done: p.done, total: p.total, status: p.status, sizeMB: p.sizeMB, elapsed: p.elapsed }); } catch {}
    }, 700);
    try {
      const r = await api.syncDiscovery();
      window.clearInterval(poll);
      setProg(null);
      setInfo((prev) => (prev ? { ...prev, hasLibrary: true, libraryInfo: r.libraryInfo } : prev));
      await analyze(result?.home?.key ?? info?.settings.homeKey);
    } catch (e: any) {
      window.clearInterval(poll);
      setProg(null);
      if (e.body?.error === "permission") {
        setShowManual(true);
        setMsg("Your terminal doesn't have Full Disk Access, so the app can't read Photos. Grant it in System Settings › Privacy & Security › Full Disk Access (add your terminal), restart the terminal, then try again — or run the command below yourself.");
      } else if (e.body?.error === "not_found") {
        setMsg("osxphotos isn't installed or isn't on the PATH. Run `npm run setup`, or use the manual command below.");
        setShowManual(true);
      } else {
        setMsg(e.body?.stderr || e.message || String(e));
        setShowManual(true);
      }
    } finally {
      setSyncing(false);
    }
  };

  const copy = () => {
    if (info?.command) navigator.clipboard.writeText(info.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const createAll = async () => {
    if (!result) return;
    setCreatingAll(true);
    for (const s of result.suggestions) {
      if (created[s.start] === "done" || created[s.start] === "busy") continue;
      await create(s);
    }
    setCreatingAll(false);
  };

  const create = async (s: DiscoverySuggestion) => {
    const year = s.start.slice(0, 4);
    const slug = `${slugify(s.title)}-${year}`;
    setCreated((c) => ({ ...c, [s.start]: "busy" }));
    try {
      await api.createTrip({ slug, title: s.title, kicker: s.kicker, emoji: s.emoji, startDate: s.start, days: s.days, sheets: 30, queryFrom: s.start, queryTo: addDay(s.end) });
      setCreated((c) => ({ ...c, [s.start]: "done" }));
      onCreated();
    } catch (e: any) {
      setCreated((c) => ({ ...c, [s.start]: e.body?.error === "slug_exists" ? "A trip with this name already exists" : (e.message || "failed") }));
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal discover" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>Discover trips from your photos</h2>
        <p className="muted">Sync your Photos library metadata (dates and locations only — no images leave your Mac), and get trip suggestions based on where you traveled.</p>

        <div className="disc-sync">
          <div className="disc-range">
            <label>From<input type="date" value={info?.settings.from || ""} onChange={(e) => info && setRange(e.target.value, info.settings.to)} /></label>
            <label>To<input type="date" value={info?.settings.to || ""} onChange={(e) => info && setRange(info.settings.from, e.target.value)} /></label>
            {info?.libraryInfo && <span className="disc-synced">last synced {new Date(info.libraryInfo.syncedAt).toLocaleDateString()} · {info.libraryInfo.sizeMB} MB</span>}
          </div>
          <div className="disc-sync-actions">
            <button className="btn-primary" onClick={syncNow} disabled={syncing || analyzing}>
              {syncing ? "Syncing your library…" : info?.hasLibrary ? "Sync again" : "Sync now"}
            </button>
            {info?.hasLibrary && (
              <button className="btn-ghost" onClick={() => analyze(result?.home?.key ?? info?.settings.homeKey)} disabled={syncing || analyzing}>
                {analyzing ? "Analyzing…" : "Re-analyze"}
              </button>
            )}
            <button className="disc-manual-toggle" onClick={() => setShowManual((v) => !v)}>
              {showManual ? "hide manual command" : "run it manually"}
            </button>
          </div>
          {syncing && (
            <div className="disc-prog">
              <div className={`exp-bar${prog && prog.total > 0 ? "" : " indeterminate"}`}>
                <div className="exp-fill" style={prog && prog.total > 0 ? { width: `${Math.round((prog.done / prog.total) * 100)}%` } : undefined} />
              </div>
              <div className="disc-prog-label">
                {prog?.status || "Reading your library…"}
                {prog && prog.total > 0 ? ` · ${prog.done.toLocaleString()}/${prog.total.toLocaleString()}` : prog && prog.sizeMB > 0 ? ` · ${prog.sizeMB} MB` : ""}
                {prog ? ` · ${fmtElapsed(prog.elapsed)}` : ""}
              </div>
            </div>
          )}
          {showManual && (
            <div className="disc-manual">
              <p className="muted">Runs the same command in your terminal, then click Re-analyze:</p>
              <div className="cmd">
                <code>{info?.command || "…"}</code>
                <button className="btn-copy" onClick={copy}>{copied ? "copied ✓" : "copy"}</button>
              </div>
            </div>
          )}
        </div>

        {msg && <p className="err-msg">{msg}</p>}

        {result && result.home && (
          <div className="disc-home">
            <label>Home base
              <select value={result.home.key} onChange={(e) => analyze(e.target.value)}>
                {result.clusters.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.days} days)</option>)}
              </select>
            </label>
            <span className="muted">Trips are the times you were away from here.</span>
          </div>
        )}

        {result && (
          <div className="disc-suggestions">
            {result.suggestions.length > 0 && (
              <div className="disc-suggestions-head">
                <span>{result.suggestions.length} trip{result.suggestions.length === 1 ? "" : "s"} found</span>
                <button className="btn-ghost sm" onClick={createAll} disabled={creatingAll}>{creatingAll ? "Creating…" : "Create all"}</button>
              </div>
            )}
            {result.suggestions.length === 0 && <p className="muted">No trips found in this range. Try widening the dates, or pick a different home base.</p>}
            {result.suggestions.map((s) => {
              const st = created[s.start];
              return (
                <div className="disc-card" key={s.start}>
                  <span className="disc-emoji">{s.emoji}</span>
                  <div className="disc-meta">
                    <div className="disc-title">{s.title}{s.kicker ? <span className="disc-kicker"> · {s.kicker}</span> : null}</div>
                    <div className="disc-sub">{fmt(s.start)} — {fmt(s.end)}, {s.start.slice(0, 4)} · {s.days} days · {s.photos} photos</div>
                  </div>
                  {st === "done" ? (
                    <a className="disc-created" href={`/trip/${slugify(s.title)}-${s.start.slice(0, 4)}`}>Created ✓ open</a>
                  ) : st && st !== "busy" ? (
                    <span className="disc-err">{st}</span>
                  ) : (
                    <button className="btn-primary sm" onClick={() => create(s)} disabled={st === "busy"}>{st === "busy" ? "…" : "Create trip"}</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
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
