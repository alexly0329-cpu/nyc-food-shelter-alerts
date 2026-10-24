import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db.js';
import { encryptPhone, phoneHash } from '../src/crypto.js';
import { revokeConsent } from '../src/recipients/revoke.js';
import { buildMessageText, runSendJob, voiceLocale, type Sender } from '../src/alerts/send.js';

const pool = getPool();
const HOUR = 3_600_000;
const NOW = new Date('2026-06-01T16:00:00Z'); // 12:00 PM ET
const STARTS = new Date('2026-06-01T21:00:00Z'); // 5:00 PM ET
const ENDS = new Date('2026-06-01T23:00:00Z');
const MSG = 'Free hot meals tonight';
const SMS_TEXT = `Pantry: ${MSG} 1 Main St, 5:00 PM. Reply STOP to opt out.`;
const VOICE_TEXT = (n: string) => `Pantry: ${MSG} 1 Main St, 5:00 PM. To stop these calls, text STOP to ${n}.`;

let providerId: string;
let seq = 0;
const phones = new Map<string, string>(); // recipient id -> phone

async function addRecipient(lat: number, o: { channel?: 'sms' | 'voice'; language?: string } = {}) {
  const phone = `+1718555${String(1000 + seq++)}`;
  const id = (await pool.query(
    `INSERT INTO recipients (phone, phone_hash, channel, language, zip, lat, lng, enrolled_by_provider_id)
     VALUES ($1, $2, $3, $4, '11201', $5, -74.0, $6) RETURNING id`,
    [encryptPhone(phone), phoneHash(phone), o.channel ?? 'sms', o.language ?? 'English', lat, providerId],
  )).rows[0].id as string;
  await pool.query(
    `INSERT INTO consents (recipient_id, provider_id, method, consent_text_version) VALUES ($1, $2, 'verbal', 'v1')`,
    [id, providerId],
  );
  phones.set(id, phone);
  return { id, phone };
}

async function addAlert(o: { cap?: number; urgent?: boolean; status?: string; ends?: Date } = {}) {
  return (await pool.query(
    `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, urgent, verification_status, idempotency_key)
     VALUES ($1, 'food', '1 Main St', 40.7, -74.0, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [providerId, MSG, STARTS, o.ends ?? ENDS, o.cap ?? 10, o.urgent ?? false, o.status ?? 'verified', `k${seq++}`],
  )).rows[0].id as string;
}

type Call = { kind: 'sms' | 'call'; to: string; text: string; language?: string };
function fakeSender(hook?: (c: Call) => Promise<void> | void) {
  const calls: Call[] = [];
  const sender: Sender = {
    async sendSms(to, text) {
      const c: Call = { kind: 'sms', to, text };
      calls.push(c);
      await hook?.(c);
      return { id: `sms-${calls.length}` };
    },
    async startCall(to, text, language) {
      const c: Call = { kind: 'call', to, text, language };
      calls.push(c);
      await hook?.(c);
      return { id: `call-${calls.length}` };
    },
  };
  return { sender, calls };
}

const enqueue = vi.fn(async () => {});
const mk = (sender: Sender, now: () => Date = () => NOW) => ({ db: pool, sender, enqueue, now, sleep: async () => {} });
const state = async (id: string) => (await pool.query('SELECT send_state, sent_at FROM alerts WHERE id = $1', [id])).rows[0];
const deliveries = async (id: string) =>
  (await pool.query('SELECT recipient_id, status, vonage_id FROM deliveries WHERE alert_id = $1', [id])).rows;

beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, alerts, consents, recipients, providers CASCADE');
  providerId = (await pool.query(
    `INSERT INTO providers (name, address, contact, status) VALUES ('Pantry', '1 Main St', 'Pat', 'approved') RETURNING id`,
  )).rows[0].id;
  seq = 0;
  phones.clear();
  enqueue.mockClear();
  process.env.VONAGE_NUMBER = '+19175550100';
});
afterEach(() => {
  delete process.env.VONAGE_NUMBER;
  vi.restoreAllMocks();
});
afterAll(() => pool.end());

describe('buildMessageText / voiceLocale', () => {
  const a = { providerName: 'Pantry', message: MSG, address: '1 Main St', startsAt: STARTS };
  it('builds exact sms and voice text', () => {
    expect(buildMessageText(a, 'sms')).toBe(SMS_TEXT);
    expect(buildMessageText(a, 'voice')).toBe(VOICE_TEXT('+19175550100'));
  });
  it('voice text without VONAGE_NUMBER points to the enrolling organization', () => {
    delete process.env.VONAGE_NUMBER;
    expect(buildMessageText(a, 'voice')).toBe(
      `Pantry: ${MSG} 1 Main St, 5:00 PM. To stop these calls, ask the organization that enrolled you.`,
    );
  });
  it('formats start time in New York (DST and noon/midnight)', () => {
    expect(buildMessageText({ ...a, startsAt: new Date('2026-01-15T14:05:00Z') }, 'sms')).toContain(', 9:05 AM.');
    expect(buildMessageText({ ...a, startsAt: new Date('2026-06-01T16:00:00Z') }, 'sms')).toContain(', 12:00 PM.');
  });
  it('maps languages to TTS locales with en-US fallback', () => {
    expect(['English', 'Español', '中文', 'Русский', 'en', 'es', 'zh', 'ru', 'Klingon', ''].map(voiceLocale)).toEqual([
      'en-US', 'es-US', 'zh-CN', 'ru-RU', 'en-US', 'es-US', 'zh-CN', 'ru-RU', 'en-US', 'en-US',
    ]);
  });
});

describe('runSendJob', () => {
  it('sends to every recipient by channel with exact text and locale', async () => {
    const s = await addRecipient(40.71);
    const v = await addRecipient(40.72, { channel: 'voice', language: 'Español' });
    const id = await addAlert();
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    expect([...calls].sort((x, y) => x.to.localeCompare(y.to))).toEqual([
      { kind: 'sms', to: s.phone, text: SMS_TEXT },
      { kind: 'call', to: v.phone, text: VOICE_TEXT('+19175550100'), language: 'es-US' },
    ]);
    const rows = await deliveries(id);
    expect(rows.map((r) => [r.status, r.vonage_id !== null])).toEqual([['queued', true], ['queued', true]]);
    const st = await state(id);
    expect(st.send_state).toBe('sent');
    expect(st.sent_at).toEqual(NOW);
  });

  it('one throwing send is marked failed and the others still go', async () => {
    const a = await addRecipient(40.71);
    const b = await addRecipient(40.72);
    const c = await addRecipient(40.73);
    const id = await addAlert();
    const { sender, calls } = fakeSender((call) => {
      if (call.to === b.phone) throw new Error(`boom ${b.phone}`);
    });
    await runSendJob(mk(sender), id);
    expect(calls).toHaveLength(3);
    const by = Object.fromEntries((await deliveries(id)).map((r) => [r.recipient_id, r]));
    expect(by[a.id].status).toBe('queued');
    expect(by[b.id]).toMatchObject({ status: 'failed', vonage_id: null });
    expect(by[c.id].status).toBe('queued');
    expect((await state(id)).send_state).toBe('sent');
  });

  it('sends nothing for an unverified alert, and returns quietly for an unknown id', async () => {
    await addRecipient(40.71);
    const id = await addAlert({ status: 'needs_review' });
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    await runSendJob(mk(sender), '00000000-0000-0000-0000-000000000000');
    expect(calls).toHaveLength(0);
    expect(await deliveries(id)).toHaveLength(0);
    expect((await state(id)).send_state).toBe('pending');
  });

  it('expires an alert past ends_at even if urgent, sending nothing', async () => {
    await addRecipient(40.71);
    const id = await addAlert({ urgent: true });
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender, () => new Date(ENDS.getTime() + 1000)), id);
    expect(calls).toHaveLength(0);
    expect((await state(id)).send_state).toBe('expired');
    expect(await deliveries(id)).toHaveLength(0);
  });

  it('does nothing for already sent or expired alerts', async () => {
    await addRecipient(40.71);
    const id = await addAlert();
    await pool.query("UPDATE alerts SET send_state = 'sent' WHERE id = $1", [id]);
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    expect(calls).toHaveLength(0);
  });

  describe('quiet hours', () => {
    const NIGHT = new Date('2026-06-02T03:00:00Z'); // 11 PM ET
    const longEnd = new Date('2026-06-02T20:00:00Z');
    it('defers to 8 AM ET via enqueue, state stays pending, nothing sent', async () => {
      await addRecipient(40.71);
      const id = await addAlert({ ends: longEnd });
      const { sender, calls } = fakeSender();
      await runSendJob(mk(sender, () => NIGHT), id);
      expect(enqueue).toHaveBeenCalledWith(id, new Date('2026-06-02T12:00:00Z'));
      expect(calls).toHaveLength(0);
      expect((await state(id)).send_state).toBe('pending');
    });
    it('urgent sends during quiet hours', async () => {
      await addRecipient(40.71);
      const id = await addAlert({ ends: longEnd, urgent: true });
      const { sender, calls } = fakeSender();
      await runSendJob(mk(sender, () => NIGHT), id);
      expect(calls).toHaveLength(1);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  it('a recipient who revokes consent between selection and send is stopped and not messaged', async () => {
    const a = await addRecipient(40.71);
    const b = await addRecipient(40.72);
    const id = await addAlert();
    // Send order within an alert is unspecified: whichever goes first revokes the other.
    let first: string | undefined;
    const { sender, calls } = fakeSender(async (c) => {
      if (first) return;
      first = c.to;
      await revokeConsent(pool, c.to === a.phone ? b.phone : a.phone);
    });
    await runSendJob(mk(sender), id);
    expect(calls).toHaveLength(1);
    const loser = first === a.phone ? b : a;
    const by = Object.fromEntries((await deliveries(id)).map((r) => [r.recipient_id, r]));
    expect(by[loser.id]).toMatchObject({ status: 'stopped', vonage_id: null });
  });

  it('time passing ends_at mid-run fails the remaining rows and sends no more', async () => {
    await addRecipient(40.71);
    await addRecipient(40.72);
    await addRecipient(40.73);
    const id = await addAlert();
    let t = NOW.getTime();
    let afterFirst = false;
    const { sender, calls } = fakeSender(() => { afterFirst = true; });
    // now() jumps past ends_at once the first send has happened
    await runSendJob(mk(sender, () => new Date(afterFirst ? ENDS.getTime() + 1 : t)), id);
    expect(calls).toHaveLength(1);
    const rows = await deliveries(id);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'failed' && r.vonage_id === null)).toHaveLength(2);
    expect((await state(id)).send_state).toBe('sent');
  });

  it('respects the cap', async () => {
    for (let i = 0; i < 7; i++) await addRecipient(40.71 + i / 100);
    const id = await addAlert({ cap: 5 });
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    expect(calls).toHaveLength(5);
    expect(await deliveries(id)).toHaveLength(5);
  });

  it('fewer eligible than cap sends to all', async () => {
    await addRecipient(40.71);
    await addRecipient(40.72);
    const id = await addAlert({ cap: 50 });
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    expect(calls).toHaveLength(2);
    expect((await state(id)).send_state).toBe('sent');
  });

  it('zero eligible: sent with no deliveries and no error', async () => {
    const id = await addAlert();
    const { sender, calls } = fakeSender();
    await expect(runSendJob(mk(sender), id)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await deliveries(id)).toHaveLength(0);
    expect((await state(id)).send_state).toBe('sent');
  });

  it('resume sends only unsent queued rows and does not reselect', async () => {
    const done = await addRecipient(40.71);
    const todo = await addRecipient(40.72);
    await addRecipient(40.73); // eligible but must NOT be picked up on resume
    const id = await addAlert({ cap: 2 });
    await pool.query("UPDATE alerts SET send_state = 'sending' WHERE id = $1", [id]);
    await pool.query("INSERT INTO deliveries (alert_id, recipient_id, vonage_id) VALUES ($1, $2, 'x1')", [id, done.id]);
    await pool.query('INSERT INTO deliveries (alert_id, recipient_id) VALUES ($1, $2)', [id, todo.id]);
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    expect(calls.map((c) => c.to)).toEqual([todo.phone]);
    expect(await deliveries(id)).toHaveLength(2);
    expect((await state(id)).send_state).toBe('sent');
  });

  it('resume: consent revoked before the resume marks the row stopped', async () => {
    const r = await addRecipient(40.71);
    const id = await addAlert();
    await pool.query("UPDATE alerts SET send_state = 'sending' WHERE id = $1", [id]);
    await pool.query('INSERT INTO deliveries (alert_id, recipient_id) VALUES ($1, $2)', [id, r.id]);
    await revokeConsent(pool, r.phone);
    const { sender, calls } = fakeSender();
    await runSendJob(mk(sender), id);
    expect(calls).toHaveLength(0);
    expect((await deliveries(id))[0].status).toBe('stopped');
  });

  it('running twice, sequentially or in parallel, messages each recipient once', async () => {
    for (let i = 0; i < 6; i++) await addRecipient(40.71 + i / 100);
    const id1 = await addAlert({ cap: 6 });
    const seqRun = fakeSender();
    await runSendJob(mk(seqRun.sender), id1);
    await runSendJob(mk(seqRun.sender), id1);
    expect(seqRun.calls).toHaveLength(6);

    await pool.query('TRUNCATE deliveries');
    const id2 = await addAlert({ cap: 6 });
    const par = fakeSender(() => new Promise((r) => setTimeout(r, 5)));
    await Promise.all([runSendJob(mk(par.sender), id2), runSendJob(mk(par.sender), id2), runSendJob(mk(par.sender), id2)]);
    const counts = new Map<string, number>();
    for (const c of par.calls) counts.set(c.to, (counts.get(c.to) ?? 0) + 1);
    expect(counts.size).toBe(6);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(await deliveries(id2)).toHaveLength(6);
  });

  it('logs no phone numbers or message bodies', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const a = await addRecipient(40.71);
    await addRecipient(40.72);
    const id = await addAlert();
    const { sender } = fakeSender((c) => { if (c.to === a.phone) throw new Error(`fail ${c.to} ${c.text}`); });
    await runSendJob(mk(sender), id);
    const out = spies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(' ')).join('\n');
    expect(out).not.toMatch(/555|Free hot meals/);
    const stored = JSON.stringify(await deliveries(id));
    expect(stored).not.toMatch(/555|Free hot meals|fail \+/);
  });
});
