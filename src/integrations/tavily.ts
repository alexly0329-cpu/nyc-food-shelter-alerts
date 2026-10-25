import { tavily } from '@tavily/core';
import { checkHoursInText, type HoursCheck } from './hours.js';

export interface TavilyLike {
  search(query: string): Promise<{ results: Array<{ title: string; content: string; url: string }> }>;
}

export function createTavilyClient(apiKey?: string): TavilyLike {
  return {
    async search(query) {
      const key = apiKey ?? process.env.TAVILY_API_KEY;
      if (!key) throw new Error('TAVILY_API_KEY is not set');
      return tavily({ apiKey: key }).search(query, { maxResults: 5 });
    },
  };
}

const SUFFIXES: Record<string, string> = {
  ave: 'avenue', st: 'street', blvd: 'boulevard', rd: 'road', pl: 'place', dr: 'drive', ln: 'lane', ct: 'court',
  n: 'north', s: 'south', e: 'east', w: 'west',
};
const UNIT_MARKERS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', 'fl', 'floor', 'rm', 'room']);
const BARE = new Set(['north', 'south', 'east', 'west', 'saint']);

// `st` is a saint only as the first street-name token: the house number sits right before it and nothing street-like
// (a direction or another number, as in "100 W 21 St" or "31-10 21 St") sits before that number.
const isSaint = (words: string[], i: number) =>
  /^\d+$/.test(words[i - 1] ?? '') && !/^\d+$/.test(words[i - 2] ?? 'x') && !['n', 's', 'e', 'w', 'north', 'south', 'east', 'west'].includes(words[i - 2] ?? '');

// Lowercase, punctuation to spaces, suffix and direction abbreviations expanded, padded for whole-word matching.
// "st" straight after a house number is a saint ("10 St Marks Pl"), anywhere else a street.
// dropUnit (alert address only): cut at the first unit marker after the house number.
function norm(s: string, dropUnit = false): string {
  let words = (dropUnit ? s.replace(/#/g, ' unit ') : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (dropUnit) {
    const i = words.findIndex((w, k) => k >= 1 && UNIT_MARKERS.has(w));
    if (i >= 0) words = words.slice(0, i);
  }
  return ` ${words.map((w, i) => (w === 'st' && isSaint(words, i) ? 'saint' : SUFFIXES[w] ?? w)).join(' ')} `;
}

// Search results are untrusted web text: we only compare strings, never act on or echo them.
// Returns the raw text of every result containing both name and street ([] when none match).
async function matches(client: TavilyLike, name: string, address: string): Promise<string[] | 'error'> {
  const street = norm(address.split(',')[0] ?? '', true);
  const n = norm(name);
  // Weak needles verify too easily: need "<number> <street of 2+ chars>" and a name of 4+ chars or 2+ words.
  const rest = /^ \d+ (.+) $/.exec(street)?.[1] ?? '';
  const nameOk = n.trim().length >= 4 || n.trim().split(' ').length >= 2;
  if (rest.length < 2 || BARE.has(rest) || !nameOk) return [];
  const query = `${name.slice(0, 100)} ${address.slice(0, 150)} NYC food shelter`;
  try {
    const { results } = await client.search(query);
    return (results ?? [])
      .map((r) => `${r.title ?? ''} ${r.content ?? ''}`)
      .filter((raw) => {
        const text = norm(raw);
        return text.includes(n) && text.includes(street);
      });
  } catch {
    return 'error';
  }
}

// Matching checks provider name plus street address. Hours only demote on a clear conflict; absent hours do not.
export async function verifyAlert(
  client: TavilyLike,
  input: { providerName: string; address: string; startsAt: Date; endsAt: Date },
): Promise<{ status: 'verified' | 'needs_review'; detail: string; hoursCheck: HoursCheck }> {
  const m = await matches(client, input.providerName, input.address);
  if (m === 'error') return { status: 'needs_review', detail: 'verification service error', hoursCheck: 'unconfirmed' };
  if (m.length === 0) return { status: 'needs_review', detail: 'no web result matches provider name and address', hoursCheck: 'unconfirmed' };
  const checks = m.map((text) => checkHoursInText(text, input.startsAt, input.endsAt));
  const hoursCheck: HoursCheck = checks.includes('confirmed') ? 'confirmed' : checks.includes('conflict') ? 'conflict' : 'unconfirmed';
  if (hoursCheck === 'conflict') return { status: 'needs_review', detail: 'hours conflict', hoursCheck };
  return { status: 'verified', detail: 'web result matches provider name and address', hoursCheck };
}

export async function verifyProvider(
  client: TavilyLike,
  input: { name: string; address: string },
): Promise<{ status: 'likely_legit' | 'flagged'; detail: string }> {
  const m = await matches(client, input.name, input.address);
  if (m !== 'error' && m.length) return { status: 'likely_legit', detail: 'web result matches provider name and address' };
  return { status: 'flagged', detail: m === 'error' ? 'verification service error' : 'no web result matches provider name and address' };
}
