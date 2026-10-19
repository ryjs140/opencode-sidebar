#!/usr/bin/env node
/*
 * Verifies the runtime l10n bundles:
 *  - every vscode.l10n.t('...') literal in src/ has an entry in both bundles
 *  - the English and Chinese bundles share exactly the same keys
 *  - {n} placeholders match between source and translation
 *  - no stale keys remain in the bundles
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'l10n/bundle.l10n.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(root, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'));

const keys = new Map();
for (const file of fs.readdirSync(path.join(root, 'src'))) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  const pattern = /vscode\.l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    if (!keys.has(key)) keys.set(key, file);
  }
}

const placeholders = value => [...value.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',');
const problems = [];

for (const [key, file] of [...keys].sort()) {
  if (!(key in en)) problems.push(`missing from bundle.l10n.json (${file}): ${key}`);
  if (!(key in zh)) problems.push(`missing from bundle.l10n.zh-cn.json (${file}): ${key}`);
  if (key in zh && placeholders(key) !== placeholders(zh[key])) {
    problems.push(`placeholder mismatch: ${key} -> ${zh[key]}`);
  }
}
for (const key of Object.keys(en)) {
  if (!keys.has(key)) problems.push(`unused key in bundle.l10n.json: ${key}`);
  if (!(key in zh)) problems.push(`missing from bundle.l10n.zh-cn.json: ${key}`);
}
for (const key of Object.keys(zh)) {
  if (!(key in en)) problems.push(`key missing from bundle.l10n.json: ${key}`);
  if (key in en && zh[key] === en[key]) problems.push(`untranslated value: ${key}`);
}

if (problems.length) {
  console.error('l10n verification failed:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(`l10n OK: ${keys.size} runtime strings resolve in English and Simplified Chinese.`);
