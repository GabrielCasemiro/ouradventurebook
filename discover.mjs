// Trip discovery from Apple Photos metadata (dates + locations).
// Pure functions, no I/O — the server feeds it the parsed osxphotos JSON and
// gets back a detected home base, the location clusters, and trip suggestions.

const DAY = 86400000;
const toNum = (v) => (typeof v === "number" && isFinite(v) ? v : null);

export const haversineKm = (aLat, aLon, bLat, bLon) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

// ISO alpha-2 country code → flag emoji
export const flagEmoji = (cc) =>
  cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "";

const firstName = (place, key) => {
  const v = place?.names?.[key];
  return Array.isArray(v) && v[0] ? String(v[0]) : null;
};

// Turn one raw osxphotos record into a compact { day, lat, lon, cc, country, city }.
export const parseRecord = (p) => {
  const date = p?.date || p?.created || null;
  if (!date) return null;
  const place = p?.place || {};
  const lat = toNum(p?.latitude ?? place?.location?.[0]);
  const lon = toNum(p?.longitude ?? place?.location?.[1]);
  const cc = (place?.country_code || "").toUpperCase() || null;
  return {
    day: String(date).slice(0, 10),
    lat, lon, cc,
    country: firstName(place, "country") || null,
    city: firstName(place, "city") || firstName(place, "locality") ||
          firstName(place, "sub_administrative_area") || firstName(place, "state_province") || null,
    hasGps: lat != null && lon != null,
  };
};

const clusterKey = (r) =>
  r.city ? `${r.city}|${r.country || r.cc || ""}` : (r.country || r.cc || `@${r.lat?.toFixed(1)},${r.lon?.toFixed(1)}`);

const clusterLabel = (r) => r.city && r.country ? `${r.city}, ${r.country}` : (r.city || r.country || r.cc || "Unknown");

// Build location clusters (for home detection and the home override list).
const buildClusters = (recs) => {
  const map = new Map();
  for (const r of recs) {
    if (!r.hasGps) continue;
    const k = clusterKey(r);
    let c = map.get(k);
    if (!c) { c = { key: k, label: clusterLabel(r), cc: r.cc, country: r.country, city: r.city, days: new Set(), n: 0, latSum: 0, lonSum: 0 }; map.set(k, c); }
    c.days.add(r.day); c.n++; c.latSum += r.lat; c.lonSum += r.lon;
  }
  return [...map.values()]
    .map((c) => ({ key: c.key, label: c.label, cc: c.cc, country: c.country, city: c.city, days: c.days.size, photos: c.n, lat: c.latSum / c.n, lon: c.lonSum / c.n }))
    .sort((a, b) => b.days - a.days || b.photos - a.photos);
};

const dayMs = (day) => Date.parse(day + "T00:00:00");
const spanDays = (a, b) => Math.round((dayMs(b) - dayMs(a)) / DAY) + 1;

/**
 * @param rawPhotos array of osxphotos JSON records
 * @param opts { homeKey?, minKm=100, minDays=2, gapDays=2, minPhotos=8, existingRanges=[{start,end}] }
 * @returns { home, clusters, suggestions }
 */
export function analyzeLibrary(rawPhotos, opts = {}) {
  const { homeKey = null, minKm = 100, minDays = 2, gapDays = 2, minPhotos = 8, existingRanges = [] } = opts;
  const recs = [];
  for (const p of rawPhotos || []) { const r = parseRecord(p); if (r) recs.push(r); }

  const clusters = buildClusters(recs);
  if (!clusters.length) return { home: null, clusters: [], suggestions: [] };
  const home = (homeKey && clusters.find((c) => c.key === homeKey)) || clusters[0];

  // per-day gps records
  const byDay = new Map();
  for (const r of recs) { if (!r.hasGps) continue; (byDay.get(r.day) || byDay.set(r.day, []).get(r.day)).push(r); }

  // classify each day as away from home
  const awayDays = [];
  const dayInfo = new Map();
  for (const [day, rs] of byDay) {
    const lat = rs.reduce((s, r) => s + r.lat, 0) / rs.length;
    const lon = rs.reduce((s, r) => s + r.lon, 0) / rs.length;
    // dominant country code that day
    const ccCount = {};
    for (const r of rs) if (r.cc) ccCount[r.cc] = (ccCount[r.cc] || 0) + 1;
    const cc = Object.entries(ccCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const far = home.lat != null ? haversineKm(lat, lon, home.lat, home.lon) > minKm : false;
    const diffCountry = cc && home.cc && cc !== home.cc;
    dayInfo.set(day, { lat, lon, cc, recs: rs });
    if (far || diffCountry) awayDays.push(day);
  }
  awayDays.sort();

  // merge away-days into trips, bridging small gaps (travel days)
  const groups = [];
  for (const day of awayDays) {
    const g = groups[groups.length - 1];
    if (g && (dayMs(day) - dayMs(g.end)) <= gapDays * DAY) g.end = day;
    else groups.push({ start: day, end: day });
  }

  const overlaps = (s, e) =>
    existingRanges.some((r) => dayMs(s) <= dayMs(r.end) && dayMs(e) >= dayMs(r.start));

  const suggestions = [];
  for (const g of groups) {
    if (spanDays(g.start, g.end) < minDays) continue;
    // all records within the range
    const inRange = recs.filter((r) => r.day >= g.start && r.day <= g.end);
    const away = inRange.filter((r) => r.hasGps && dayInfo.get(r.day) &&
      ((home.lat != null && haversineKm(r.lat, r.lon, home.lat, home.lon) > minKm) || (r.cc && home.cc && r.cc !== home.cc)));
    if (inRange.length < minPhotos) continue;
    // dominant place among away photos
    const countBy = (key) => {
      const m = {};
      for (const r of away) { const v = r[key]; if (v) m[v] = (m[v] || 0) + 1; }
      return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    };
    const cc = countBy("cc");
    const country = countBy("country");
    const city = countBy("city");
    const international = cc && home.cc ? cc !== home.cc : (country && home.country ? country !== home.country : false);
    const title = international ? (country || city || "Trip") : (city || country || "Trip");
    const kicker = international ? (city || country || "") : (country && country !== title ? country : "");
    const emoji = international && cc ? flagEmoji(cc) : "📍";
    if (overlaps(g.start, g.end)) continue;
    suggestions.push({
      start: g.start,
      end: g.end,
      days: spanDays(g.start, g.end),
      photos: inRange.length,
      title, kicker, emoji, country, city, cc,
      international: !!international,
    });
  }
  suggestions.sort((a, b) => (a.start < b.start ? 1 : -1));
  return { home, clusters: clusters.slice(0, 12), suggestions };
}
