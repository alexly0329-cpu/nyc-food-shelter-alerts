import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Reads the real tokens from styles.css, so changing a colour there re-runs these checks.
const css = readFileSync('public/styles.css', 'utf8');
const tokens: Record<string, string> = {};
for (const m of css.slice(0, css.indexOf('}')).matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) tokens[m[1]] = m[2];

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// [foreground, background, minimum ratio]: 4.5 for text, 3 for UI borders and large text.
const PAIRS: Array<[string, string, number]> = [
  ['text', 'bg', 4.5], ['text', 'surface', 4.5], ['text', 'surface-2', 4.5],
  ['muted', 'bg', 4.5], ['muted', 'surface', 4.5], ['muted', 'surface-2', 4.5],
  ['blue', 'bg', 4.5],
  ['link', 'bg', 4.5], ['link', 'surface', 4.5], ['link', 'surface-2', 4.5],
  ['ok', 'bg', 4.5], ['ok', 'surface', 4.5], ['ok', 'surface-2', 4.5],
  ['bad', 'bg', 4.5], ['bad', 'surface', 4.5], ['bad', 'surface-2', 4.5],
  ['accent', 'bg', 4.5], ['accent', 'surface', 4.5], ['accent', 'surface-2', 4.5],
  ['on-accent', 'accent', 4.5], ['on-accent', 'bad', 4.5],
  ['on-ink', 'ink', 4.5],
  ['edge', 'bg', 3], ['edge', 'surface', 3], ['edge', 'surface-2', 3],
  ['accent', 'bg', 3], // focus ring
];

describe('light theme contrast', () => {
  it('reads every token it needs', () => {
    for (const [f, b] of PAIRS) { expect(tokens[f], f).toBeDefined(); expect(tokens[b], b).toBeDefined(); }
  });
  for (const [f, b, min] of PAIRS) {
    it(`${f} on ${b} is at least ${min}:1`, () => expect(ratio(tokens[f]!, tokens[b]!)).toBeGreaterThanOrEqual(min));
  }
});
