import { tavily } from '@tavily/core';

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
};

// Lowercase, punctuation to spaces, suffix abbreviations expanded, padded for whole-word matching.
function norm(s: string): string {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return ` ${words.map((w) => SUFFIXES[w] ?? w).join(' ')} `;
}

// Search results are untrusted web text: we only compare strings, never act on or echo them.
async function matches(client: TavilyLike, name: string, address: string): Promise<boolean | 'error'> {
  const street = norm(address.split(',')[0] ?? '');
  const n = norm(name);
  // Weak needles verify too easily: need "<number> <street of 2+ chars>" and a name of 4+ chars or 2+ words.
  const rest = /^ \d+ (.+) $/.exec(street)?.[1] ?? '';
  const nameOk = n.trim().length >= 4 || n.trim().split(' ').length >= 2;
  if (rest.length < 2 || !nameOk) return false;
  const query = `${name.slice(0, 100)} ${address.slice(0, 150)} NYC food shelter`;
  try {
    const { results } = await client.search(query);
    return (results ?? []).some((r) => {
      const text = norm(`${r.title ?? ''} ${r.content ?? ''}`);
      return text.includes(n) && text.includes(street);
    });
  } catch {
    return 'error';
  }
}

// v1 matching checks provider name plus street address only; startsAt/endsAt are accepted but not compared.
export async function verifyAlert(
  client: TavilyLike,
  input: { providerName: string; address: string; startsAt: Date; endsAt: Date },
): Promise<{ status: 'verified' | 'needs_review'; detail: string }> {
  const m = await matches(client, input.providerName, input.address);
  if (m === true) return { status: 'verified', detail: 'web result matches provider name and address' };
  return { status: 'needs_review', detail: m === 'error' ? 'verification service error' : 'no web result matches provider name and address' };
}

export async function verifyProvider(
  client: TavilyLike,
  input: { name: string; address: string },
): Promise<{ status: 'likely_legit' | 'flagged'; detail: string }> {
  const m = await matches(client, input.name, input.address);
  if (m === true) return { status: 'likely_legit', detail: 'web result matches provider name and address' };
  return { status: 'flagged', detail: m === 'error' ? 'verification service error' : 'no web result matches provider name and address' };
}
