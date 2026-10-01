#!/usr/bin/env node
// Lints one or more manifests (and the catalog) and prints actionable findings.
// Exit code 1 if there is any error; warnings alone exit 0.
//
//   node scripts/lint.mjs path/to/manifest.json [more.json ...] [--catalog <catalog dir or file>]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../lib/catalog/load-catalog.mjs';
import { lintManifest, lintCatalog } from '../lib/manifest/lint-manifest.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const catalogIdx = args.indexOf('--catalog');
const catalogPath = catalogIdx >= 0 ? args.splice(catalogIdx, 2)[1] : path.join(root, 'catalog', 'providers');
const manifestPaths = args;

if (manifestPaths.length === 0) {
  console.error('usage: node scripts/lint.mjs <manifest.json> [...] [--catalog <catalog.json>]');
  process.exit(2);
}

const catalog = (await fs.stat(catalogPath)).isDirectory() ? await loadCatalog(catalogPath) : JSON.parse(await fs.readFile(catalogPath, 'utf8'));
let errors = 0;
let warnings = 0;
const report = (label, findings) => {
  if (findings.length === 0) { console.log(`ok    ${label}`); return; }
  for (const f of findings) {
    f.level === 'error' ? errors++ : warnings++;
    console.log(`${f.level === 'error' ? 'ERROR' : 'warn '} ${label}: ${f.message}`);
  }
};

report(`catalog ${path.basename(catalogPath)}`, lintCatalog(catalog));
for (const p of manifestPaths) {
  report(p, lintManifest(JSON.parse(await fs.readFile(p, 'utf8')), catalog));
}
console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
