import { describe, expect, it } from 'vitest';
import { distanceKm, zipToCentroid } from '../src/geo/geo.js';

describe('zipToCentroid', () => {
  it('returns the centroid for a known NYC zip', () => {
    const c = zipToCentroid('11216');
    expect(c).not.toBeNull();
    expect(Math.abs(c!.lat - 40.675)).toBeLessThan(0.05);
    expect(Math.abs(c!.lng - -73.948)).toBeLessThan(0.05);
  });

  it('covers Bronx and Staten Island', () => {
    expect(zipToCentroid('10451')).not.toBeNull();
    expect(zipToCentroid('10301')).not.toBeNull();
  });

  it.each(['90210', '1121', '', '112160', '1121a', ' 11216', '__proto__', 'constructor', 'toString'])(
    'rejects %j',
    (zip) => expect(zipToCentroid(zip)).toBeNull(),
  );
});

describe('distanceKm', () => {
  it('10001 to 11216 is about 10 km', () => {
    const d = distanceKm(zipToCentroid('10001')!, zipToCentroid('11216')!);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(12);
  });

  it('is zero for identical points', () => {
    expect(distanceKm({ lat: 40.7, lng: -74 }, { lat: 40.7, lng: -74 })).toBe(0);
  });
});
