import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db.js';
import { buildServer } from '../src/server.js';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const pool = getPool();
let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer({
    db: pool, tavily: { search: vi.fn(async () => ({ results: [] })) }, geocode: async () => null,
    enqueue: async () => {}, now: () => new Date(), secureCookies: false,
    sender: { sendSms: vi.fn(async () => ({ id: 'm' })), startCall: vi.fn(async () => ({ id: 'c' })) },
    signatureSecret: () => undefined,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('static serving', () => {
  it('GET / is HTML with security headers', async () => {
    const r = await app.inject('/');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
  for (const [path, type] of [['/app.js', /javascript/], ['/lib.js', /javascript/], ['/styles.css', /^text\/css/]] as const) {
    it(`GET ${path}`, async () => {
      const r = await app.inject(path);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(type);
      expect(r.headers['content-security-policy']).toBe(CSP);
    });
  }
  it('unknown non-API path is a 404 that still carries CSP and nosniff', async () => {
    const r = await app.inject('/nope');
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('unknown /api path is a JSON 404', async () => {
    const r = await app.inject('/api/does-not-exist');
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });
  it('unknown /webhooks path is a non-HTML 404', async () => {
    const r = await app.inject('/webhooks/does-not-exist');
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).not.toMatch(/html/);
  });
  it('API keeps its gate and no-store', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: 'a=b', headers: { 'content-type': 'text/plain' } });
    expect(r.statusCode).toBe(415);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('CSP-clean source', () => {
  const html = readFileSync('public/index.html', 'utf8');
  it('index.html has no inline script, style, style attr or handler', () => {
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toMatch(/\bsrc=/);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
  it('JS uses no HTML-string or eval sinks', () => {
    for (const f of ['public/app.js', 'public/lib.js']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    }
  });
  it('every sign-out and 401 path goes through a full reload that clears UI state', () => {
    const js = readFileSync('public/app.js', 'utf8');
    expect(js).toMatch(/function signedOut\(\)[^\n]*location\.reload\(\)/);
    expect(js).toMatch(/\$\('#signout'\)[\s\S]*?api\('POST', '\/api\/logout', \{\}\);\s*signedOut\(\)/);
    expect(js.match(/status === 401\) return signedOut\(\)/g)?.length).toBe(4);
  });
  it('enroll view has a separate opt-out section that never keeps the number', () => {
    const js = readFileSync('public/app.js', 'utf8');
    expect(html).toContain('Someone asked to stop?');
    expect(html).toMatch(/<input id="optPh"[^>]*autocomplete="off"/);
    expect(html).toMatch(/<label for="optPh">/);
    expect(html).toContain('Stop messages to this number');
    expect(js).toContain("api('POST', '/api/optout'");
    expect(html).toContain("Done. We won't message that number again.");
    expect(js).toMatch(/\$\('#optPh'\)\.value = ''/);
  });
  it('radio groups have legends', () => {
    expect(html.match(/<fieldset>\s*<legend\b/g)?.length).toBe(html.match(/<fieldset>/g)?.length);
  });
});
