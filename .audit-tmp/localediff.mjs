import { build } from 'esbuild';
async function load(p) {
  const r = await build({ entryPoints: [p], bundle: true, format: 'esm', write: false });
  const m = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
  return Object.keys(Object.values(m)[0]).sort();
}
const base = 'C:/HaloUI/src/locales';
const langs = ['ru','en','zh','ja'];
const [ru, en, zh, ja] = await Promise.all(langs.map(l => load(`${base}/${l}.ts`)));
const ruSet = new Set(ru);
for (const [name, keys] of [['en', en], ['zh', zh], ['ja', ja]]) {
  const set = new Set(keys);
  const extra = keys.filter(k => !ruSet.has(k));
  const missing = ru.filter(k => !set.has(k));
  console.log(`--- ${name}: ${keys.length} keys (ru has ${ru.length})`);
  if (extra.length) console.log(`  EXTRA not in ru: ${JSON.stringify(extra)}`);
  if (missing.length) console.log(`  MISSING (${missing.length}): ${JSON.stringify(missing)}`);
  if (!extra.length && !missing.length) console.log('  in sync');
}
// duplicate keys in each file (detect via raw source regex)
import { readFileSync } from 'fs';
for (const l of langs) {
  const src = readFileSync(`${base}/${l}.ts`, 'utf8');
  const keys = [...src.matchAll(/^\s*"([^"]+)"\s*:/gm)].map(m => m[1]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) console.log(`DUPLICATE keys in ${l}.ts: ${[...new Set(dup)].join(', ')}`);
}
