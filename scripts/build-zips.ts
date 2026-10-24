// Usage: npx tsx scripts/build-zips.ts <path to 2023_Gaz_zcta_national.txt>
// Source: US Census 2023 ZCTA gazetteer. Writes src/geo/nyc-zips.json.
import { readFileSync, writeFileSync } from 'node:fs';

const NYC_PREFIX = /^(10[0-4]|11[1-4]|116)\d{2}$/;

const input = process.argv[2];
if (!input) throw new Error('usage: build-zips.ts <gazetteer.txt>');

const [header, ...rows] = readFileSync(input, 'utf8').split(/\r?\n/);
const cols = header.split('\t').map((c) => c.trim());
const [iZip, iLat, iLng] = ['GEOID', 'INTPTLAT', 'INTPTLONG'].map((name) => {
  const i = cols.indexOf(name);
  if (i < 0) throw new Error(`missing column ${name}`);
  return i;
});

const zips: Record<string, { lat: number; lng: number }> = {};
for (const row of rows) {
  const f = row.split('\t').map((c) => c.trim());
  const lat = Number(f[iLat]);
  const lng = Number(f[iLng]);
  if (NYC_PREFIX.test(f[iZip] ?? '') && Number.isFinite(lat) && Number.isFinite(lng)) {
    zips[f[iZip]] = { lat, lng };
  }
}

const sorted = Object.fromEntries(Object.entries(zips).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(new URL('../src/geo/nyc-zips.json', import.meta.url), JSON.stringify(sorted, null, 1) + '\n');
console.log(`wrote ${Object.keys(sorted).length} zips`);
