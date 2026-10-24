import { alertStatusLabel, errorMessage, friendlyError, toIso, touchesQuietHours } from '/lib.js';

const $ = (s) => document.querySelector(s);
const views = ['login', 'apply', 'alerts', 'new', 'enroll'];
let me = null; // { providerName, status, role } once signed in

// Never log or store form values: enrollment forms hold phone numbers.
async function api(method, path, body) {
  try {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* empty or non-JSON body */ }
    return { status: r.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) (k === 'class' ? e.setAttribute('class', v) : e.setAttribute(k, v));
  e.append(...kids);
  return e;
}
const ICONS = {
  ok: ['3', 'M4 12l5 5L20 6'],
  wait: ['2.6', 'M12 7v5l3 2'],
  bad: ['3', 'M6 6l12 12M18 6L6 18'],
};
function icon(tone) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': ICONS[tone][0], 'aria-hidden': 'true' })) s.setAttribute(k, v);
  if (tone === 'wait') {
    const c = document.createElementNS(NS, 'circle');
    for (const [k, v] of Object.entries({ cx: '12', cy: '12', r: '9' })) c.setAttribute(k, v);
    s.append(c);
  }
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[tone][1]);
  s.append(p);
  return s;
}

function toast(t) {
  const e = $('#toast');
  e.textContent = t;
  e.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (e.hidden = true), 4000);
}
function showErr(id, msg) {
  const e = $(id);
  e.textContent = msg;
  e.hidden = false;
  e.focus();
}
const clearErr = (id) => { $(id).hidden = true; $(id).textContent = ''; };

// ---------- routing ----------
const canSend = () => me?.role === 'staff' && me.status === 'approved';
function allowed(v) {
  if (!me) return v === 'login' || v === 'apply';
  if (v === 'login' || v === 'apply') return false;
  if (v === 'new' || v === 'enroll') return canSend();
  return true;
}
function route() {
  let v = location.hash.slice(1);
  if (!views.includes(v)) v = me ? 'alerts' : 'login';
  if (!allowed(v)) {
    const dest = me ? 'alerts' : 'login';
    if (location.hash.slice(1) !== dest) { location.hash = dest; return; } // hashchange re-enters route()
    v = dest;
  }
  views.forEach((n) => $('#v-' + n).classList.toggle('on', n === v));
  $('#nav').hidden = !me;
  const admin = me?.role === 'admin';
  $('#nav').querySelectorAll('a').forEach((a) => {
    a.hidden = admin || (a.dataset.v !== 'alerts' && !canSend());
    a.dataset.v === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  $('#v-' + v).querySelector('h1')?.focus();
  scrollTo(0, 0);
  if (v === 'alerts') showAlerts();
  if (v === 'new') paint();
}
addEventListener('hashchange', route);

function setMe(m) {
  me = m;
  const name = m?.providerName || (m?.role === 'admin' ? 'Admin' : '');
  $('#orgName').textContent = name;
  const banner = $('#statusBanner');
  banner.hidden = !m || m.role === 'admin' || m.status === 'approved';
  banner.textContent = m?.status === 'suspended' ? 'Your account is suspended' : 'Your application is pending review';
  $('#adminNote').hidden = m?.role !== 'admin';
  paint();
}
// A full reload is the one reliable way to drop every typed value, draft, alert list and key
// from the page, so the next person on a shared computer starts clean.
function signedOut() { location.replace('/#login'); location.reload(); }

// ---------- login / apply / logout ----------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr('#loginErr');
  const btn = $('#loginBtn');
  btn.disabled = true;
  const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#pw').value });
  btn.disabled = false;
  if (r.status !== 200) return showErr('#loginErr', errorMessage(r.status === 401 ? 'invalid_credentials' : r.data?.error ?? ''));
  $('#pw').value = '';
  await boot('alerts');
});

$('#applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr('#applyErr');
  $('#applyOk').hidden = true;
  const btn = $('#applyBtn');
  btn.disabled = true;
  const r = await api('POST', '/api/apply', {
    name: $('#aName').value, address: $('#aAddr').value, contactName: $('#aContact').value,
    phone: $('#aPhone').value, website: $('#aWeb').value || undefined, email: $('#aEmail').value, password: $('#aPw').value,
  });
  btn.disabled = false;
  if (r.status === 201) {
    e.target.reset();
    $('#applyOk').hidden = false;
    return;
  }
  showErr('#applyErr', r.status === 400 && r.data?.message ? r.data.message : errorMessage(r.data?.error ?? ''));
});

$('#signout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {});
  signedOut();
});

// ---------- alerts list ----------
async function showAlerts() {
  const list = $('#alertList');
  if (!canSend()) return list.replaceChildren(); // admin or not approved: the banner explains, the API would 403
  list.replaceChildren(el('p', { class: 'empty', role: 'status' }, 'Loading your alerts…'));
  const r = await api('GET', '/api/alerts');
  if (r.status === 401) return signedOut();
  if (r.status !== 200 || !Array.isArray(r.data)) {
    const retry = el('button', { class: 'btn plain', type: 'button' }, 'Retry');
    retry.addEventListener('click', showAlerts);
    return list.replaceChildren(el('div', { class: 'empty', role: 'alert' }, el('p', {}, "We couldn't load your alerts."), retry));
  }
  if (!r.data.length) return list.replaceChildren(el('p', { class: 'empty' }, 'No alerts yet. Post your first alert.'));
  list.replaceChildren(...r.data.map((a, i) => alertRow(a, i === 0)));
}

function alertRow(a, open) {
  const st = alertStatusLabel(a);
  const when = new Date(a.startsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const held = a.verification !== 'verified';
  const stat = (n, label, tone) => el('div', {}, el('b', tone ? { class: tone } : {}, String(n)), el('span', {}, label));
  const detail = held
    ? el('div', { class: 'detail' }, el('p', {}, 'Nothing was sent. Check the address and hours, then post again.'))
    : el('div', { class: 'detail' },
        el('div', { class: 'stats' },
          stat(a.texted, 'Texted or called'), stat(a.delivered, 'Delivered', 'ok'),
          stat(a.failed, 'Failed. Wrong or inactive number.', 'bad'), stat(a.stopped, 'Replied STOP')));
  const d = el('details', {},
    el('summary', {},
      el('span', { class: 't' }, a.title),
      el('span', { class: 's' }, `${a.address} · cap ${a.capacityCap} · ${when}`),
      el('span', { class: 'badge ' + st.tone }, icon(st.tone), st.text)),
    detail);
  d.open = open;
  return d;
}

// ---------- new alert ----------
let cap = 60;
let idemKey = crypto.randomUUID(); // regenerated only after a successful post
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function defaultTimes() {
  const s = new Date(); s.setHours(s.getHours() + 1, 0, 0, 0);
  const e = new Date(s); e.setHours(e.getHours() + 2);
  $('#start').value = fmt(s);
  $('#end').value = fmt(e);
}
defaultTimes();

function paint() {
  $('#capN').textContent = cap;
  $('#fill').style.width = Math.min(100, (cap / 500) * 100) + '%';
  $('#capT').textContent = `We'll stop sending after ${cap} people.`;
  const m = $('#msg').value;
  $('#count').textContent = `${m.length} of 100 characters`;
  const t = new Date($('#start').value);
  const time = isNaN(t) ? '' : t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const e = new Date($('#end').value);
  $('#quiet').hidden = $('#urgent').checked || !touchesQuietHours(t, e);
  $('#bubble').textContent = `${me?.providerName ?? ''}: ${m} ${$('#addr').value}, ${time}. Reply STOP to opt out.`;
}
$('#minus').addEventListener('click', () => { cap = Math.max(5, cap - 5); paint(); });
$('#plus').addEventListener('click', () => { cap = Math.min(500, cap + 5); paint(); });
['msg', 'addr', 'start', 'end', 'urgent'].forEach((i) => $('#' + i).addEventListener('input', paint));

$('#alertForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr('#alertErr');
  const startsAt = toIso($('#start').value), endsAt = toIso($('#end').value);
  if (!startsAt || !endsAt) return showErr('#alertErr', 'Pick a start and end time.');
  if (endsAt <= startsAt) return showErr('#alertErr', 'The end time must be after the start time.');
  if (new Date(endsAt) <= new Date()) return showErr('#alertErr', 'The end time must be in the future.');
  const btn = $('#alertBtn');
  btn.disabled = true;
  const r = await api('POST', '/api/alerts', {
    serviceType: document.querySelector('input[name=svc]:checked').value,
    address: $('#addr').value, startsAt, endsAt,
    message: $('#msg').value, capacityCap: cap, urgent: $('#urgent').checked, idempotencyKey: idemKey,
  });
  btn.disabled = false;
  if (r.status === 401) return signedOut();
  if (r.status === 403) return boot(); // suspended mid-session: the banner replaces the form
  if (r.status !== 201) return showErr('#alertErr', friendlyError(r.data?.error ?? '', r.data?.message));
  idemKey = crypto.randomUUID();
  e.target.reset();
  cap = 60;
  defaultTimes();
  toast(r.data?.status === 'needs_review' ? "Alert saved but not sent. We couldn't confirm the address." : "Alert posted. It's queued to send.");
  location.hash = 'alerts';
});

// ---------- enroll ----------
const gate = () => ($('#enrollBtn').disabled = !$('#agreed').checked);
$('#agreed').addEventListener('change', gate);
$('#enrollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr('#enrollErr');
  const btn = $('#enrollBtn');
  btn.disabled = true;
  const r = await api('POST', '/api/enroll', {
    phone: $('#ph').value, channel: document.querySelector('input[name=ch]:checked').value, language: $('#lang').value,
    zip: $('#zip').value, method: document.querySelector('input[name=how]:checked').value, scriptConfirmed: $('#agreed').checked,
  });
  gate();
  if (r.status === 401) return signedOut();
  if (r.status === 403) return boot();
  if (r.status !== 201) return showErr('#enrollErr', errorMessage(r.data?.error ?? ''));
  e.target.reset();
  gate();
  toast('Enrolled. They can reply STOP any time.');
});

// ---------- start ----------
async function boot(dest) {
  const r = await api('GET', '/api/me');
  if (r.status === 200 && r.data) {
    setMe(r.data);
    if (dest && location.hash.slice(1) !== dest) { location.hash = dest; return; } // hashchange runs route()
  } else setMe(null);
  route();
}
boot();
