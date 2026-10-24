import { describe, expect, it } from 'vitest';
import { verifyAlert, verifyProvider, type TavilyLike } from '../src/integrations/tavily.js';
import { geocodeAddress } from '../src/integrations/geocode.js';

const fake = (results: Array<{ title: string; content: string; url: string }>): TavilyLike => ({
  search: async () => ({ results }),
});
const throwing: TavilyLike = {
  search: async () => {
    throw new Error('boom key=tvly-SECRET');
  },
};
const alert = {
  providerName: 'Marcy Community Pantry',
  address: '214 Marcy Ave, Brooklyn',
  startsAt: new Date('2026-11-01T14:00:00Z'),
  endsAt: new Date('2026-11-01T18:00:00Z'),
};
const hit = (title: string, content: string) => ({ title, content, url: 'https://example.org' });

describe('verifyAlert', () => {
  it('verifies when result has name and street', async () => {
    const r = await verifyAlert(fake([hit('Marcy Community Pantry', 'Open at 214 Marcy Avenue, Brooklyn.')]), alert);
    expect(r.status).toBe('verified');
  });
  it('abbreviations match both ways', async () => {
    const r = await verifyAlert(fake([hit('x', 'marcy community pantry, 214 MARCY AVENUE')]), alert);
    expect(r.status).toBe('verified');
    const r2 = await verifyAlert(fake([hit('x', 'Marcy Community Pantry 214 Marcy Ave.')]), { ...alert, address: '214 Marcy Avenue' });
    expect(r2.status).toBe('verified');
  });
  it('zero results needs review', async () => {
    expect((await verifyAlert(fake([]), alert)).status).toBe('needs_review');
  });
  it('client throw needs review, no throw, no secret', async () => {
    const r = await verifyAlert(throwing, alert);
    expect(r.status).toBe('needs_review');
    expect(r.detail).not.toContain('SECRET');
  });
  it('different street number does not verify', async () => {
    const r = await verifyAlert(fake([hit('Marcy Community Pantry', '2140 Marcy Avenue')]), alert);
    expect(r.status).toBe('needs_review');
    const r2 = await verifyAlert(fake([hit('Marcy Community Pantry', '300 Marcy Avenue')]), alert);
    expect(r2.status).toBe('needs_review');
  });
  it('name only does not verify', async () => {
    const r = await verifyAlert(fake([hit('Marcy Community Pantry', 'great place')]), alert);
    expect(r.status).toBe('needs_review');
  });
  it('bounds query length', async () => {
    let q = '';
    const c: TavilyLike = { search: async (s) => ((q = s), { results: [] }) };
    await verifyAlert(c, { ...alert, providerName: 'A'.repeat(5000) });
    expect(q.length).toBeLessThan(500);
  });
});

describe('weak needles', () => {
  const run = (name: string, address: string, text: string) =>
    verifyAlert(fake([hit('t', text)]), { ...alert, providerName: name, address }).then((r) => r.status);
  it('street part under 2 characters never verifies', async () => {
    expect(await run('Hope', '5 A', 'Hope at 5 A')).toBe('needs_review');
    expect(await run('Hope Pantry', '5 A, Brooklyn', 'Hope Pantry 5 A')).toBe('needs_review');
  });
  it('one-word name of 4+ characters is allowed, under 4 is not, two short tokens are', async () => {
    expect(await run('Pantry', '214 Marcy Ave', 'Pantry 214 Marcy Avenue')).toBe('verified');
    expect(await run('Hop', '214 Marcy Ave', 'Hop 214 Marcy Avenue')).toBe('needs_review');
    expect(await run('A B', '214 Marcy Ave', 'A B 214 Marcy Avenue')).toBe('verified');
  });
});

describe('verifyProvider', () => {
  const p = { name: 'Marcy Community Pantry', address: '214 Marcy Ave' };
  it('match is likely_legit', async () => {
    const r = await verifyProvider(fake([hit('t', 'Marcy Community Pantry at 214 Marcy Avenue')]), p);
    expect(r.status).toBe('likely_legit');
  });
  it('no match flagged', async () => {
    expect((await verifyProvider(fake([hit('t', 'unrelated')]), p)).status).toBe('flagged');
  });
  it('error flagged', async () => {
    expect((await verifyProvider(throwing, p)).status).toBe('flagged');
  });
});

describe('geocodeAddress', () => {
  const ok = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  const feat = (coordinates: unknown) => ({ features: [{ geometry: { coordinates } }] });

  it('returns lat/lng in correct order (GeoJSON is lng first)', async () => {
    expect(await geocodeAddress('214 Marcy Ave', ok(feat([-73.95, 40.7])))).toEqual({ lat: 40.7, lng: -73.95 });
  });
  it('encodes the address in the url', async () => {
    let url = '';
    const f = (async (u: string) => ((url = u), new Response(JSON.stringify(feat([-73.95, 40.7]))))) as unknown as typeof fetch;
    await geocodeAddress('214 Marcy Ave & x', f);
    expect(url).toBe('https://geosearch.planninglabs.nyc/v2/search?text=214%20Marcy%20Ave%20%26%20x&size=1');
  });
  it('null on empty features', async () => {
    expect(await geocodeAddress('x', ok({ features: [] }))).toBeNull();
  });
  it('null on non-OK', async () => {
    const f = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    expect(await geocodeAddress('x', f)).toBeNull();
  });
  it('null on thrown error', async () => {
    const f = (async () => {
      throw new Error('net');
    }) as typeof fetch;
    expect(await geocodeAddress('x', f)).toBeNull();
  });
  it('null outside NYC', async () => {
    expect(await geocodeAddress('x', ok(feat([-118.24, 34.05])))).toBeNull();
  });
  const withProps = (properties: unknown) => ({ features: [{ geometry: { coordinates: [-73.95, 40.7] }, properties }] });
  it('null when match_type is fallback', async () => {
    expect(await geocodeAddress('x', ok(withProps({ match_type: 'fallback' })))).toBeNull();
  });
  it('null when confidence is below 0.7, accepted at 0.7 and above', async () => {
    expect(await geocodeAddress('x', ok(withProps({ confidence: 0.69 })))).toBeNull();
    expect(await geocodeAddress('x', ok(withProps({ confidence: 0.7 })))).toEqual({ lat: 40.7, lng: -73.95 });
    expect(await geocodeAddress('x', ok(withProps({ confidence: 1, match_type: 'exact' })))).toEqual({ lat: 40.7, lng: -73.95 });
  });
  it('accepts when properties or the fields are absent, ignores non-numeric confidence', async () => {
    expect(await geocodeAddress('x', ok(withProps({})))).toEqual({ lat: 40.7, lng: -73.95 });
    expect(await geocodeAddress('x', ok(withProps(undefined)))).toEqual({ lat: 40.7, lng: -73.95 });
    expect(await geocodeAddress('x', ok(withProps({ confidence: 'low' })))).toEqual({ lat: 40.7, lng: -73.95 });
  });
  it('null on malformed JSON', async () => {
    const f = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    expect(await geocodeAddress('x', f)).toBeNull();
  });
  it.each([[[]], [['a', 'b']], [null], [[-73.95]]])('null on bad coordinates %j', async (c) => {
    expect(await geocodeAddress('x', ok(feat(c)))).toBeNull();
  });
});
