import { adminErrorMessage, alertStatusLabel, errorMessage, formatEt, friendlyError, hoursLabel, providerStatusLabel, startTooFar, tavilyLabel, toIso, touchesQuietHours } from '/lib.js';

const $ = (s) => document.querySelector(s);
const views = ['login', 'apply', 'alerts', 'new', 'enroll', 'admin-providers', 'admin-alerts', 'admin-optout'];
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
  if (v.startsWith('admin-')) return me.role === 'admin';
  if (me.role === 'admin') return false; // staff views: the server would 403 an admin anyway
  if (v === 'new' || v === 'enroll') return canSend();
  return true;
}
const home = () => (me?.role === 'admin' ? 'admin-alerts' : me ? 'alerts' : 'login');
function route() {
  let v = location.hash.slice(1);
  if (!views.includes(v)) v = home();
  if (!allowed(v)) {
    const dest = home();
    if (location.hash.slice(1) !== dest) { location.hash = dest; return; } // hashchange re-enters route()
    v = dest;
  }
  views.forEach((n) => $('#v-' + n).classList.toggle('on', n === v));
  $('#nav').hidden = !me;
  const role = me?.role === 'admin' ? 'admin' : 'staff';
  $('#nav').querySelectorAll('a').forEach((a) => {
    a.hidden = a.dataset.role !== role || (role === 'staff' && a.dataset.v !== 'alerts' && !canSend());
    a.dataset.v === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  $('#v-' + v).querySelector('h1')?.focus();
  scrollTo(0, 0);
  if (v === 'alerts') showAlerts();
  if (v === 'new') paint();
  if (v === 'admin-providers') loadProviders(false);
  if (v === 'admin-alerts') loadHeld(false);
  if (v === 'admin-optout') { $('#aoPh').value = ''; $('#aoOk').hidden = true; clearErr('#aoErr'); }
}
addEventListener('hashchange', route);

function setMe(m) {
  me = m;
  const name = m?.providerName || (m?.role === 'admin' ? 'Admin' : '');
  $('#orgName').textContent = name;
  const banner = $('#statusBanner');
  banner.hidden = !m || m.role === 'admin' || m.status === 'approved';
  banner.textContent = m?.status === 'suspended' ? 'Your account is suspended' : 'Your application is pending review';
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
  await boot(true);
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
  const time = isNaN(t) ? '' : t.toLocaleString('en-US', { ...(t.toDateString() === new Date().toDateString() ? {} : { weekday: 'short' }), hour: 'numeric', minute: '2-digit' }).replace(',', '');
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
  if (startTooFar(startsAt)) return showErr('#alertErr', 'The start time must be within the next 24 hours.');
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

// ---------- opt-out ----------
// The number lives only in the input and is cleared after every submit.
$('#optoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr('#optErr');
  $('#optOk').hidden = true;
  const btn = $('#optBtn');
  btn.disabled = true;
  const r = await api('POST', '/api/optout', { phone: $('#optPh').value });
  btn.disabled = false;
  if (r.status === 401) return signedOut();
  if (r.status === 403) return boot();
  if (r.status !== 200) return showErr('#optErr', errorMessage(r.data?.error ?? ''));
  $('#optPh').value = '';
  $('#optOk').hidden = false;
});

// ---------- admin ----------
// Admin calls: a 401 drops everything (open confirms, lists) through the reload-to-login path.
async function adminApi(method, path, body) {
  const r = await api(method, path, body);
  if (r.status === 401) { signedOut(); return null; }
  return r;
}
const badge = (l) => el('span', { class: 'badge ' + l.tone }, icon(l.tone), l.text);
const facts = (rows) => el('dl', { class: 'facts' }, ...rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
const text = (v) => (v == null || v === '' ? 'Not given' : String(v));

// Fetch and render a list. `row(item, load)` builds a card; focus goes to the heading after an action.
function loader(listId, noun, url, emptyText, row) {
  let seq = 0; // ignore a slow earlier response after the filter changed
  const load = async (focus) => {
    const n = ++seq, list = $(listId);
    list.replaceChildren(el('p', { class: 'empty', role: 'status' }, `Loading ${noun}…`));
    const r = await adminApi('GET', url());
    if (!r || n !== seq) return;
    if (r.status !== 200 || !Array.isArray(r.data)) {
      const retry = el('button', { class: 'btn plain', type: 'button' }, 'Retry');
      retry.addEventListener('click', () => load(true));
      const box = el('div', { class: 'empty', role: 'alert', tabindex: '-1' }, el('p', {}, `We couldn't load ${noun}.`), retry);
      list.replaceChildren(box);
      return box.focus();
    }
    list.replaceChildren(...(r.data.length ? r.data.map((x) => row(x, load)) : [el('p', { class: 'empty' }, emptyText())]));
    if (focus) list.closest('main').querySelector('h1').focus();
  };
  return load;
}

// POST an admin action. Buttons stay disabled while the request runs; 404/409 refresh the list since it was stale.
async function runAction(path, busy, errId, okText, reload, restore) {
  clearErr(errId);
  busy.forEach((b) => (b.disabled = true));
  const r = await adminApi('POST', path);
  if (!r) return;
  if (r.status === 200) { toast(okText); return reload(true); }
  busy.forEach((b) => (b.disabled = false));
  restore?.();
  showErr(errId, adminErrorMessage(r.status, r.data?.error));
  if ((r.status === 404 || r.status === 409) && r.data?.error !== 'geocode_failed') reload(false);
}

// In-page two-step confirm: the buttons swap for a question; focus moves into it and back on Cancel.
function askConfirm(actions, trigger, question, label, run) {
  const q = el('p', { tabindex: '-1' }, question);
  const yes = el('button', { class: 'btn danger', type: 'button' }, label);
  const no = el('button', { class: 'btn plain', type: 'button' }, 'Cancel');
  const box = el('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm action' }, q, el('div', { class: 'actions' }, yes, no));
  const close = () => { box.remove(); actions.hidden = false; };
  no.addEventListener('click', () => { close(); trigger.focus(); });
  yes.addEventListener('click', () => run([yes, no], () => { close(); trigger.focus(); }));
  actions.hidden = true;
  actions.after(box);
  q.focus();
}

function providerRow(p, load) {
  const c = p.contact && typeof p.contact === 'object' ? p.contact : { contactName: p.contact };
  const go = (act, okText, busy, restore) => runAction(`/api/admin/providers/${p.id}/${act}`, busy, '#provErr', okText, load, restore);
  const approve = el('button', { class: 'btn', type: 'button', 'aria-label': `Approve ${p.name}` }, 'Approve');
  const suspend = el('button', { class: 'btn plain', type: 'button', 'aria-label': `Suspend ${p.name}` }, 'Suspend');
  const actions = el('div', { class: 'actions' }, ...(p.status === 'approved' ? [suspend] : [approve]));
  approve.addEventListener('click', () => go('approve', `Approved ${p.name}.`, [approve]));
  suspend.addEventListener('click', () =>
    askConfirm(actions, suspend, `Suspend ${p.name}? Alerts they already queued won't send.`, 'Confirm suspend',
      (busy, restore) => go('suspend', `Suspended ${p.name}.`, busy, restore)));
  return el('article', { class: 'card' },
    el('h3', {}, p.name), badge(providerStatusLabel(p.status)),
    facts([
      ['Address', text(p.address)], ['Online check', badge(tavilyLabel(p.tavily_result))],
      ['Contact person', text(c.contactName)], ['Phone', text(c.phone)], ['Website', text(c.website)],
      ['Applicant email', text(p.applicantEmail)], ['Applied', formatEt(p.created_at) || 'Unknown'],
    ]),
    actions);
}

function heldRow(a, load) {
  const ok = a.providerStatus === 'approved';
  const approve = el('button', { class: 'btn', type: 'button', 'aria-label': `Approve alert from ${a.providerName}` }, 'Approve');
  const reject = el('button', { class: 'btn plain', type: 'button', 'aria-label': `Reject alert from ${a.providerName}` }, 'Reject');
  const actions = el('div', { class: 'actions' }, approve, reject);
  const why = ok ? null : el('p', { class: 'reason', id: 'why-' + a.id }, a.providerStatus === 'suspended' ? "Provider suspended. This alert can't be approved." : "Provider isn't approved yet. This alert can't be approved.");
  if (why) { approve.disabled = true; approve.setAttribute('aria-describedby', why.id); }
  const go = (act, okText, busy, restore) => runAction(`/api/admin/alerts/${a.id}/${act}`, busy, '#holdErr', okText, load, restore);
  approve.addEventListener('click', () => go('approve', 'Alert approved. It is queued to send.', [approve, reject]));
  reject.addEventListener('click', () =>
    askConfirm(actions, reject, 'Reject this alert? It will never be sent.', 'Confirm reject',
      (busy, restore) => go('reject', 'Alert rejected.', busy, restore)));
  const hours = hoursLabel(a.hoursCheck);
  const where = a.geocoded ? { text: 'Address located', tone: 'ok' } : { text: 'Address not found', tone: 'bad' };
  return el('article', { class: 'card' },
    el('h3', {}, a.providerName), badge(providerStatusLabel(a.providerStatus)),
    el('p', { class: 'msg' }, a.message),
    facts([
      ['Service', { food: 'Food', shelter: 'Shelter' }[a.serviceType] ?? text(a.serviceType)], ['Address', text(a.address)],
      ['Starts', formatEt(a.startsAt) || 'Unknown'], ['Ends', formatEt(a.endsAt) || 'Unknown'],
      ['Capacity cap', text(a.capacityCap)], ['Hours', badge(hours)], ['Address check', badge(where)],
    ]),
    ...(why ? [why] : []), actions);
}

const providerFilter = () => document.querySelector('input[name=pf]:checked').value;
const loadProviders = loader('#providerList', 'providers', () => `/api/admin/providers?status=${providerFilter()}`, () => `No ${providerFilter()} applications.`, providerRow);
const loadHeld = loader('#heldList', 'held alerts', () => '/api/admin/alerts', () => 'No alerts waiting for review.', heldRow);
document.querySelectorAll('input[name=pf]').forEach((i) => i.addEventListener('change', () => { clearErr('#provErr'); loadProviders(false); }));

// Same pattern as the staff opt-out: the number lives only in the input and is cleared after every submit.
$('#adminOptoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr('#aoErr');
  $('#aoOk').hidden = true;
  const btn = $('#aoBtn');
  btn.disabled = true;
  const r = await adminApi('POST', '/api/admin/optout', { phone: $('#aoPh').value });
  if (!r) return;
  btn.disabled = false;
  if (r.status !== 200) return showErr('#aoErr', adminErrorMessage(r.status, r.data?.error));
  $('#aoPh').value = '';
  $('#aoOk').hidden = false;
});

// ---------- start ----------
async function boot(landing) {
  const r = await api('GET', '/api/me');
  if (r.status === 200 && r.data) {
    setMe(r.data);
    if (landing && location.hash.slice(1) !== home()) { location.hash = home(); return; } // hashchange runs route()
  } else setMe(null);
  route();
}
boot();
