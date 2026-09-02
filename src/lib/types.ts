export interface PhotoMeta {
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: number;
  focalLength?: number;
  shutter?: number;
  lat?: number;
  lng?: number;
  filesize?: number;
}

export interface Photo {
  uuid: string;
  filename: string;
  date: string;
  dayIndex: number;
  width: number;
  height: number;
  isFavorite: boolean;
  hasThumb: boolean;
  sig?: string;
  meta?: PhotoMeta;
  source?: string;
  hd?: boolean; // a high-res web render exists (else served as a low-res thumbnail)
  hdSource?: "original" | "preview"; // what that render was made from
  type?: "photo" | "video"; // videos play in the digital album; the printed book keeps photos only
  duration?: number; // clip length in seconds (videos only), when known
  hasVideo?: boolean; // a web-playable .mp4 render exists (videos only)
}

export interface DayInfo {
  index: number;
  date: string;
  label: string;
  count: number;
}

export interface TripInfo {
  startDate: string;
  days: number;
}

export interface Manifest {
  generatedAt: string;
  trip: TripInfo;
  days: DayInfo[];
  photos: Photo[];
}

export interface PhotoState {
  chosen?: boolean;
  caption?: string;
  dayIndex?: number;
}

export type Side = "front" | "back";
export type SlotRef = { sheet: number; side: Side; pos: 0 | 1 };

export interface Sheet {
  front: (string | null)[]; // [top, bottom]
  back: (string | null)[];
}

export interface Project {
  trip: TripInfo;
  photos: Record<string, PhotoState>;
  album: { sheets: Sheet[] };
  updatedAt: string | null;
}

export interface DiscoverySuggestion {
  start: string; end: string; days: number; photos: number;
  title: string; kicker: string; emoji: string;
  country: string | null; city: string | null; cc: string | null; international: boolean;
}
export interface DiscoveryCluster {
  key: string; label: string; days: number; photos: number;
  cc: string | null; country: string | null; city: string | null; lat: number; lon: number;
}
export interface DiscoverySettings { from: string; to: string; homeKey: string | null; }
export interface DiscoveryInfo {
  settings: DiscoverySettings; hasLibrary: boolean;
  libraryInfo: { syncedAt: string; sizeMB: number } | null; command: string;
}
export interface DiscoveryResult {
  home: DiscoveryCluster | null; clusters: DiscoveryCluster[]; suggestions: DiscoverySuggestion[]; count: number;
}

export type SocialFormat = "4x5" | "1x1" | "9x16";

export interface Carousel {
  id: string;
  title: string;
  format: SocialFormat;
  background: string; // "blur" or a 6-char hex (e.g. "FFFFFF")
  slides: string[]; // photo uuids, in order
  caption: string;
}

export interface Social {
  carousels: Carousel[];
  updatedAt?: string;
}

export interface TripConfig {
  slug: string;
  title: string;
  kicker?: string;
  emoji?: string;
  startDate: string;
  days: number;
  sheets: number;
  queryFrom?: string;
  queryTo?: string;
  matte?: { padColor: string };
  music?: string | null;
  book?: { pageW: number; pageH: number };
}

export interface TripSummary extends TripConfig {
  hasPhotos: boolean;
  chosen: number;
  placed: number;
}
