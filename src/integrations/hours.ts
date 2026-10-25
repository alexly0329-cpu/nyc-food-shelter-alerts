// Heuristic opening-hours reader for untrusted search-result text. It only parses and compares: nothing in the text is acted on or echoed.
// Every quantifier is bounded and the input is whitespace-collapsed and capped, so scanning is linear.
export type HoursCheck = 'confirmed' | 'conflict' | 'unconfirmed';

const MAX_CHARS = 20_000;
const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ALL = [0, 1, 2, 3, 4, 5, 6];

const DAYTOK = String.raw`(?:mon(?:day)?s?|tue(?:s|sday)?s?|wed(?:nesday)?s?|thu(?:r|rs|rsday|rday)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?|daily|every day|7 days|weekdays|weekends)`;
const DAYSEP = String.raw`(?:[-–—,&/+]|\b(?:to|through|thru|and)\b)`;
const TIME = String.raw`(?:noon|midnight|\d{1,2}(?::\d{2})?(?:\s?[ap]\.?\s?m\b\.?)?)`;
const JOIN = String.raw`(?:[-–—]|\b(?:to|through|thru|until|till)\b)`;

const ITEM = new RegExp(
  String.raw`(?<all>(?<![\d/])24\s?(?:/\s?7|[-\s]?(?:hours?|hrs?)\b(?!\s(?:in advance|notice|ahead|before|prior))))` +
    String.raw`|(?<![\d$:])(?<a>${TIME})\s{0,3}${JOIN}\s{0,3}(?<b>${TIME})(?!\d)` +
    String.raw`|\b(?<days>${DAYTOK}(?:\s{0,3}${DAYSEP}\s{0,3}${DAYTOK}){0,13})\b`,
  'g',
);
const DAYSCAN = new RegExp(`(${DAYTOK})|(${DAYSEP})`, 'g');
const TIMEPARSE = /^(?:(noon|midnight)|(\d{1,2})(?::(\d{2}))?(?:\s?([ap]))?)/;

interface Entry { days: Set<number>; open: number; close: number }
interface Item { kind: 'days' | 'time'; start: number; end: number; days: Set<number>; open?: number; close?: number }

function dayIndexes(tok: string): number[] {
  if (tok === 'weekdays') return [0, 1, 2, 3, 4];
  if (tok === 'weekends') return [5, 6];
  if (tok === 'daily' || tok === 'every day' || tok === '7 days') return ALL;
  return [DAY_NAMES.indexOf(tok.slice(0, 3))];
}

function parseDays(expr: string): Set<number> {
  const out = new Set<number>();
  let prev: number | null = null;
  let range = false;
  for (const m of expr.matchAll(DAYSCAN)) {
    if (m[2] !== undefined) {
      range = /^(?:[-–—]|to|through|thru)$/.test(m[2]);
      continue;
    }
    const idx = dayIndexes(m[1]);
    if (range && prev !== null && idx.length === 1) {
      for (let d: number = prev; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === idx[0]) break;
      }
    } else idx.forEach((d) => out.add(d));
    prev = idx.length === 1 ? idx[0] : null;
    range = false;
  }
  return out;
}

// Minutes after midnight plus whether am/pm and a colon were given; null when not clearly a time.
function parseTime(s: string): { min: number; mer: string | null; colon: boolean; word: boolean } | null {
  const m = TIMEPARSE.exec(s.trim());
  if (!m) return null;
  if (m[1]) return { min: m[1] === 'noon' ? 720 : 0, mer: null, colon: false, word: true };
  const h = Number(m[2]);
  const mi = m[3] === undefined ? 0 : Number(m[3]);
  if (mi > 59) return null;
  return { min: h * 60 + mi, mer: m[4] ?? null, colon: m[3] !== undefined, word: false };
}

const to24 = (min: number, mer: string | null) => {
  const h = Math.floor(min / 60);
  return ((h % 12) + (mer === 'p' ? 12 : 0)) * 60 + (min % 60);
};

function parseRange(a: string, b: string): { open: number; close: number } | null {
  const x = parseTime(a);
  const y = parseTime(b);
  if (!x || !y) return null;
  const merOk = (t: NonNullable<typeof x>) => t.word || t.mer === null || (Math.floor(t.min / 60) >= 1 && Math.floor(t.min / 60) <= 12);
  if (!merOk(x) || !merOk(y)) return null;
  const clock24 = x.mer === null && y.mer === null && x.colon && y.colon && !x.word && !y.word;
  if (!clock24 && x.mer === null && y.mer === null && !x.word && !y.word) return null;
  if (clock24) {
    const [o, c] = [x.min, y.min];
    return o < 24 * 60 && c <= 24 * 60 ? { open: o, close: c } : null;
  }
  const ex = (t: typeof x, mer: string) => (t.word ? t.min : to24(t.min, t.mer ?? mer));
  const other = (m: string) => (m === 'a' ? 'p' : 'a');
  let open: number;
  let close: number;
  if (y.mer || y.word) {
    close = y.word && y.min === 0 && !x.word ? 1440 : ex(y, y.mer ?? 'p');
    open = ex(x, y.mer ?? 'p');
    if (x.mer === null && !x.word && open > close) open = ex(x, other(y.mer ?? 'p'));
  } else {
    open = ex(x, x.mer ?? 'a');
    close = ex(y, x.mer ?? 'a');
    if (!y.word && close < open) close = ex(y, other(x.mer ?? 'a'));
  }
  return open === close ? null : { open, close };
}

const GAP_OK = /^\W*(?:(?:open|hours|from|at|is|are)\W*)?$/;
const GAP_JOIN = /^\W{0,4}(?:and\W*)?$/;

export function checkHoursInText(text: string, startsAt: Date, endsAt: Date): HoursCheck {
  void endsAt;
  try {
    if (Number.isNaN(startsAt.getTime())) return 'unconfirmed';
    const t = String(text ?? '').slice(0, MAX_CHARS).toLowerCase().replace(/\s+/g, ' ');
    const items: Item[] = [];
    for (const m of t.matchAll(ITEM)) {
      const g = m.groups!;
      const start = m.index!;
      const end = start + m[0].length;
      if (g.all !== undefined) items.push({ kind: 'time', start, end, days: new Set(), open: 0, close: 1440 });
      else if (g.days !== undefined) items.push({ kind: 'days', start, end, days: parseDays(g.days) });
      else {
        const r = parseRange(g.a, g.b);
        if (r) items.push({ kind: 'time', start, end, days: new Set(), ...r });
      }
    }
    const entries: Entry[] = [];
    const claimed = new Set<number>();
    items.forEach((it, i) => {
      if (it.kind !== 'time') return;
      const prev = items[i - 1];
      const next = items[i + 1];
      const gapBefore = prev ? t.slice(prev.end, it.start) : '';
      const gapAfter = next ? t.slice(it.end, next.start) : '';
      let days: Set<number> | null = null;
      if (prev?.kind === 'days' && !claimed.has(i - 1) && GAP_OK.test(gapBefore)) {
        claimed.add(i - 1);
        days = prev.days;
      } else if (prev?.kind === 'time' && GAP_JOIN.test(gapBefore) && entries.length && prev.days.size) {
        days = prev.days;
      } else if (next?.kind === 'days' && !claimed.has(i + 1) && GAP_OK.test(gapAfter)) {
        claimed.add(i + 1);
        days = next.days;
      }
      it.days = days ?? new Set(ALL);
      entries.push({ days: it.days, open: it.open!, close: it.close! });
    });
    if (!entries.length) return 'unconfirmed';

    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(startsAt);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const day = DAY_NAMES.indexOf(get('weekday').toLowerCase().slice(0, 3));
    const min = Number(get('hour')) * 60 + Number(get('minute'));
    if (day < 0 || Number.isNaN(min)) return 'unconfirmed';
    const yesterday = (day + 6) % 7;
    const covers = entries.some((e) => {
      const wraps = e.close < e.open;
      if (e.days.has(day) && (wraps ? min >= e.open : min >= e.open && min <= e.close)) return true;
      return wraps && e.days.has(yesterday) && min <= e.close;
    });
    return covers ? 'confirmed' : 'conflict';
  } catch {
    return 'unconfirmed';
  }
}
