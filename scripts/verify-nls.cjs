#!/usr/bin/env node
/*
 * Verifies that every %key% reference in package.json resolves in both the
 * default (English) and the Simplified Chinese package.nls bundles, and that
 * the Chinese bundle actually differs from the English one.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));

const keys = new Set();
(function walk(value) {
  if (typeof value === 'string') {
    const match = /^%(.+)%$/.exec(value);
    if (match) keys.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach(walk);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(walk);
  }
})(manifest);

const problems = [];
for (const key of [...keys].sort()) {
  if (typeof en[key] !== 'string') problems.push(`missing in package.nls.json: ${key}`);
  if (typeof zh[key] !== 'string') problems.push(`missing in package.nls.zh-cn.json: ${key}`);
}
for (const key of Object.keys(en)) {
  if (!keys.has(key)) problems.push(`unused key in package.nls.json: ${key}`);
}
for (const key of Object.keys(zh)) {
  if (!(key in en)) problems.push(`key missing from package.nls.json: ${key}`);
  if (key in en && zh[key] === en[key] && key !== 'config.workspacePathStyle.enum.wsl.label') {
    problems.push(`untranslated value in package.nls.zh-cn.json: ${key}`);
  }
}

if (problems.length) {
  console.error('NLS verification failed:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(`NLS OK: ${keys.size} keys resolve in English and Simplified Chinese.`);
