#!/usr/bin/env node
// Standalone, offline, single-file HTML of one or more compiled environment graphs.
//
//   node scripts/export-html.mjs --out diagram.html                       # every sample environment
//   node scripts/export-html.mjs --env platform_prod --out prod.html      # one environment
//   node scripts/export-html.mjs --graph out/prod.json --catalog catalog.json --out prod.html
//
// Options: --env <id> (repeatable) | --all | --graph <file> (repeatable) | --catalog <file>
//          --data-dir <dir> (default viewer/data) | --preset blueprint|draft|neon|soft
//          --theme light|dark|auto | --title <text> | --out <file>
// The SVG renderer is the viewer's own (viewer/render-svg.mjs); no browser, Terraform or network needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStandaloneHtml } from './lib/build-standalone.mjs';
import { PRESETS } from '../viewer/render-svg.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = { env: [], graph: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') opts.all = true;
  else if (['--env', '--graph'].includes(a)) opts[a.slice(2)].push(argv[++i]);
  else if (['--catalog', '--data-dir', '--preset', '--theme', '--title', '--out'].includes(a)) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  else { console.error(`unknown argument: ${a}\nsee the header of scripts/export-html.mjs`); process.exit(2); }
}
if (opts.preset && !PRESETS[opts.preset]) { console.error(`--preset must be one of ${Object.keys(PRESETS).join(', ')}`); process.exit(2); }
if (opts.theme && !['light', 'dark', 'auto'].includes(opts.theme)) { console.error('--theme must be light, dark or auto'); process.exit(2); }

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const dataDir = path.resolve(opts.dataDir ?? path.join(root, 'viewer', 'data'));
const catalog = readJson(path.resolve(opts.catalog ?? path.join(dataDir, 'catalog.json')));

const graphs = [];
if (opts.graph.length) {
  for (const file of opts.graph) {
    const graph = readJson(path.resolve(file));
    const id = graph.environment ?? path.basename(file, '.json');
    graphs.push({ id, label: id, graph });
  }
} else {
  const listed = readJson(path.join(dataDir, 'environments.json')).environments;
  const wanted = opts.env.length ? opts.env : listed.map((e) => e.id);
  for (const id of wanted) {
    const entry = listed.find((e) => e.id === id);
    if (!entry) { console.error(`unknown environment "${id}". Known: ${listed.map((e) => e.id).join(', ')}`); process.exit(2); }
    graphs.push({ id, label: entry.label ?? id, graph: readJson(path.join(dataDir, `${id}.json`)) });
  }
}

const out = path.resolve(opts.out ?? 'infra-diagram.html');
const t0 = performance.now();
const html = buildStandaloneHtml({ graphs, catalog, title: opts.title ?? 'infra-diagram', preset: opts.preset, theme: opts.theme });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(`${out}: ${graphs.length} environment(s), ${(html.length / 1024).toFixed(0)} KB, ${Math.round(performance.now() - t0)} ms (single file, no external requests)`);
