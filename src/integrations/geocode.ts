const URL_BASE = 'https://geosearch.planninglabs.nyc/v2/search';

// Sanity box around NYC; anything outside is treated as a failed geocode.
const inNyc = (lat: number, lng: number) => lat >= 40.4 && lat <= 41.0 && lng >= -74.3 && lng <= -73.6;

/** NYC Planning Labs GeoSearch. Returns null on any failure so the alert goes to needs_review. */
export async function geocodeAddress(
  address: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetchFn(`${URL_BASE}?text=${encodeURIComponent(address)}&size=1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { features?: Array<{ geometry?: { coordinates?: unknown }; properties?: { match_type?: unknown; confidence?: unknown } }> };
    const f = body?.features?.[0];
    // A fallback match is only a rough guess (street or neighborhood); low confidence is not trusted either.
    if (f?.properties?.match_type === 'fallback') return null;
    const conf = f?.properties?.confidence;
    if (typeof conf === 'number' && conf < 0.7) return null;
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c)) return null;
    const [lng, lat] = c; // GeoJSON order is [lng, lat]
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return inNyc(lat, lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}
