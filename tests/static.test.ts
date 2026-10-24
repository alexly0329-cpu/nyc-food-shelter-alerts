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
  it('JS never uses innerHTML', () => {
    for (const f of ['public/app.js', 'public/lib.js']) expect(readFileSync(f, 'utf8')).not.toContain('innerHTML');
  });
});
