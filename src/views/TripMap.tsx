import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { photoUrl } from "../lib/api";

export interface MapPoint {
  lat: number;
  lng: number;
  uuid: string;
  caption: string;
  dayIndex: number;
}

// distinct, evenly-spread color per day
export const dayColor = (dayIndex: number, days: number) => {
  const hue = Math.round(((dayIndex - 1) / Math.max(1, days)) * 320);
  return `hsl(${hue}, 62%, 50%)`;
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function TripMap({ slug, points, days }: { slug: string; points: MapPoint[]; days: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const daysPresent = useMemo(
    () => [...new Set(points.map((p) => p.dayIndex))].sort((a, b) => a - b),
    [points]
  );

  useEffect(() => {
    if (!ref.current || !points.length) return;
    const map = L.map(ref.current, { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const bounds: [number, number][] = [];
    for (const p of points) {
      bounds.push([p.lat, p.lng]);
      const color = dayColor(p.dayIndex, days);
      const icon = L.divIcon({
        className: "daymark-wrap",
        html: `<span class="daymark" style="background:${color}">${p.dayIndex}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([p.lat, p.lng], { icon })
        .addTo(map)
        .bindPopup(
          `<div class="tripmap-pop"><img src="${photoUrl(slug, p.uuid)}" loading="lazy" alt="" />` +
            (p.caption.trim() ? `<span>${esc(p.caption)}</span>` : `<span class="d">Day ${p.dayIndex}</span>`) +
            `</div>`,
          { maxWidth: 240, className: "tripmap-popup" }
        );
    }
    map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 14 });
    return () => {
      map.remove();
    };
  }, [slug, points, days]);

  return (
    <>
      {daysPresent.length > 1 && (
        <div className="tripmap-legend">
          {daysPresent.map((d) => (
            <span key={d} className="tripmap-legend-item">
              <span className="dot" style={{ background: dayColor(d, days) }} />
              Day {d}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} className="tripmap" />
    </>
  );
}
