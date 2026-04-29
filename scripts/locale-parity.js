#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'locales');
const langs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
if (langs.length === 0) { console.error('no locale files'); process.exit(1); }

const dicts = {};
for (const l of langs) {
  dicts[l] = JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
}

function flatten(obj, prefix = '', out = new Set()) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, full, out);
    else out.add(full);
  }
  return out;
}

const reference = langs[0];
const ref = flatten(dicts[reference]);
let problems = 0;
for (const l of langs.slice(1)) {
  const cur = flatten(dicts[l]);
  const missing = [...ref].filter(k => !cur.has(k));
  const extra = [...cur].filter(k => !ref.has(k));
  if (missing.length || extra.length) {
    problems++;
    console.error(`[${l}] missing ${missing.length} key(s), extra ${extra.length}:`);
    for (const k of missing) console.error(`  - missing: ${k}`);
    for (const k of extra) console.error(`  + extra:   ${k}`);
  } else {
    console.log(`[${l}] OK`);
  }
}
process.exit(problems ? 1 : 0);
