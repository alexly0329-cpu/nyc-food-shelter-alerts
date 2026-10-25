import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '../src/recipients/enroll.js';
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
  it('font link points only at Google Fonts and the stylesheet is local', () => {
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const hrefs = links.map((l) => /href="([^"]+)"/.exec(l)?.[1] ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^(https:\/\/fonts\.googleapis\.com[\/?]|https:\/\/fonts\.googleapis\.com$|\/styles\.css$)/);
    expect(html).toContain('IBM+Plex+Sans');
    expect(html).toContain('IBM+Plex+Mono');
    expect(html).not.toMatch(/Archivo|Atkinson/);
    expect(readFileSync('public/styles.css', 'utf8')).not.toMatch(/Archivo|Atkinson|https?:\/\//);
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
  it('admin views exist with labelled controls and no staff-only leftovers', () => {
    for (const id of ['v-admin-providers', 'v-admin-alerts', 'v-admin-optout']) expect(html).toContain(`id="${id}"`);
    for (const h of ['#admin-providers', '#admin-alerts', '#admin-optout']) expect(html).toContain(`href="${h}"`);
    expect(html).not.toContain('through the API for now');
    expect(html).toMatch(/<fieldset>\s*<legend class="legend">Show providers that are<\/legend>/);
    expect(html).toMatch(/<input id="aoPh"[^>]*autocomplete="off"/);
    expect(html).toMatch(/<label for="aoPh">/);
    expect(html).toContain("Done. We won't message that number again.");
    expect(html).toMatch(/id="provErr" role="alert"/);
    expect(html).toMatch(/id="holdErr" role="alert"/);
  });
  it('admin glue: 401 goes through signedOut, confirm text is exact, phone never stored', () => {
    const js = readFileSync('public/app.js', 'utf8');
    expect(js).toMatch(/async function adminApi[\s\S]*?status === 401\) \{ signedOut\(\); return null; \}/);
    expect(js).toContain("api('POST', '/api/admin/optout'".replace('api(', 'adminApi('));
    expect(js).toMatch(/status === 403\) \{ boot\(true\); return null; \}/);
    expect(js).toContain("'aria-label': question");
    expect(js).not.toContain('Address not found');
    expect(js).toContain("Alerts they already queued won't send.");
    expect(js).toContain('Reject this alert? It will never be sent.');
    expect(js).toMatch(/\$\('#aoPh'\)\.value = ''/);
    expect(js).not.toMatch(/confirm\(|alert\(|localStorage|sessionStorage|console\./);
  });
  it('every script file the page loads is covered by the banned-pattern check', () => {
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="\/([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual(['app.js']);
    for (const f of ['app.js', 'lib.js']) expect(readFileSync(`public/${f}`, 'utf8')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
  it('consent script promises at most one message a day', () => {
    expect(html).toContain('We send no more than one message a day.');
    expect(html).not.toContain('few at most each week');
  });
  it('language options only use values the server accepts', () => {
    const values = [...html.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
    expect(values.length).toBe(6);
    for (const v of values) expect(LANGUAGES).toContain(v);
  });
  it('radio groups have legends', () => {
    expect(html.match(/<fieldset>\s*<legend\b/g)?.length).toBe(html.match(/<fieldset>/g)?.length);
  });
});

describe('landing page', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const js = readFileSync('public/app.js', 'utf8');
  const home = html.slice(html.indexOf('id="v-home"'), html.indexOf('<!-- LOGIN -->'));
  it('hero has the two-line headline, sub line and both calls to action', () => {
    expect(home).toMatch(/<h1[^>]*>\s*<span>When a pantry has food,<\/span><span class="two">the neighbors hear first\.<\/span>\s*<\/h1>/);
    expect(home).toContain('Nothing goes out until the address checks out or a person approves it.');
    expect(home).toContain('href="#login">Sign in</a>');
    expect(home.match(/href="#apply">Apply to join<\/a>/g)?.length).toBe(3);
    expect(home).toMatch(/<button[^>]*data-scroll="story"[^>]*>See how it works<\/button>/);
    expect(home).not.toMatch(/href="#story"/);
  });
  it('story is labelled as an example and has four numbered steps', () => {
    expect(home).toContain('A Tuesday at a Brooklyn pantry');
    expect(home).toContain('An example, not real data.');
    const steps = home.match(/<ol class="steps">([\s\S]*?)<\/ol>/)![1]!;
    expect(steps.match(/<li>/g)?.length).toBe(4);
    expect([...steps.matchAll(/class="num">(\d\d)</g)].map((m) => m[1])).toEqual(['01', '02', '03', '04']);
  });
  it('rules list has seven items', () => {
    expect(home).toContain('What this will never do');
    const rules = home.match(/<ul class="rules">([\s\S]*?)<\/ul>/)![1]!;
    expect(rules.match(/<li>/g)?.length).toBe(7);
  });
  it('closing call to action and prototype footer', () => {
    expect(home).toContain('Every alert is a person who said yes.');
    expect(home).toMatch(/<footer[^>]*>[\s\S]*Prototype\. Not open to real providers yet\.[\s\S]*github\.com\/alexly0329-cpu\/nyc-food-shelter-alerts/);
  });
  it('landing markup has no inline code or third-party hosts', () => {
    expect(home).not.toMatch(/<script|<style|\sstyle\s*=|\son[a-z]+\s*=|javascript:/i);
    for (const m of home.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) expect(m[1]).toBe('https://github.com/alexly0329-cpu/nyc-food-shelter-alerts');
  });
  it('sign-in and apply link back to home', () => {
    expect(html.match(/<a class="back" href="#home">Back to home<\/a>/g)?.length).toBe(2);
  });
  it('signed-out default route is home and sign-out lands on it', () => {
    expect(js).toContain("me ? 'alerts' : 'home'");
    expect(js).toContain("if (!me) return v === 'home' || v === 'login' || v === 'apply';");
    expect(js).toContain("if (v === 'home' || v === 'login' || v === 'apply') return false;");
    expect(js).toContain("location.replace('/#home')");
    expect(js).not.toContain("location.replace('/#login')");
    expect(js).toContain('prefers-reduced-motion');
  });
});
