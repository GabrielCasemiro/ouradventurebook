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
