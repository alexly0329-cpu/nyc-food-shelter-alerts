import zips from './nyc-zips.json' with { type: 'json' };

export type Point = { lat: number; lng: number };

const byZip = new Map<string, Point>(Object.entries(zips));

export function zipToCentroid(zip: string): Point | null {
  return /^\d{5}$/.test(zip) ? (byZip.get(zip) ?? null) : null;
}

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(a: Point, b: Point): number {
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
