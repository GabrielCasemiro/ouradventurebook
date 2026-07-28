import { useEffect, useRef } from "react";
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

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function TripMap({ slug, points }: { slug: string; points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !points.length) return;
    const map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const bounds: [number, number][] = [];
    for (const p of points) {
      bounds.push([p.lat, p.lng]);
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 6,
        color: "#b8862a",
        weight: 1.5,
        fillColor: "#f4d488",
        fillOpacity: 0.9,
      }).addTo(map);
      marker.bindPopup(
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
  }, [slug, points]);

  return <div ref={ref} className="tripmap" />;
}
