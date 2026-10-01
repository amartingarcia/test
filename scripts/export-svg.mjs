#!/usr/bin/env node
// Vector SVG (rects, paths, text; no raster) of compiled environment graphs, straight from the data.
//
//   node scripts/export-svg.mjs --env platform_prod --out-dir out/      # out/platform_prod.svg
//   node scripts/export-svg.mjs --all --preset soft --theme light --out-dir docs/gallery
//   node scripts/export-svg.mjs --graph out/prod.json --catalog catalog.json --out-dir out/
//
// Same renderer as the viewer's SVG button and the standalone HTML (viewer/render-svg.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg, PRESETS } from '../viewer/render-svg.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = { env: [], graph: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') opts.all = true;
  else if (['--env', '--graph'].includes(a)) opts[a.slice(2)].push(argv[++i]);
  else if (['--catalog', '--data-dir', '--preset', '--theme', '--out-dir'].includes(a)) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  else { console.error(`unknown argument: ${a}\nsee the header of scripts/export-svg.mjs`); process.exit(2); }
}
const preset = opts.preset ?? 'blueprint';
const theme = opts.theme ?? 'dark';
if (!PRESETS[preset]) { console.error(`--preset must be one of ${Object.keys(PRESETS).join(', ')}`); process.exit(2); }
if (!['light', 'dark'].includes(theme)) { console.error('--theme must be light or dark'); process.exit(2); }

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const dataDir = path.resolve(opts.dataDir ?? path.join(root, 'viewer', 'data'));
const catalog = readJson(path.resolve(opts.catalog ?? path.join(dataDir, 'catalog.json')));

const jobs = [];
if (opts.graph.length) {
  for (const file of opts.graph) { const graph = readJson(path.resolve(file)); jobs.push({ id: graph.environment ?? path.basename(file, '.json'), graph }); }
} else {
  const listed = readJson(path.join(dataDir, 'environments.json')).environments.map((e) => e.id);
  const wanted = opts.all || !opts.env.length ? listed : opts.env;
  for (const id of wanted) {
    if (!listed.includes(id)) { console.error(`unknown environment "${id}". Known: ${listed.join(', ')}`); process.exit(2); }
    jobs.push({ id, graph: readJson(path.join(dataDir, `${id}.json`)) });
  }
}

const outDir = path.resolve(opts.outDir ?? '.');
fs.mkdirSync(outDir, { recursive: true });
for (const { id, graph } of jobs) {
  const { svg, width, height, nodes } = renderSvg(graph, catalog, { preset, theme, title: id });
  const file = path.join(outDir, `${id}.svg`);
  fs.writeFileSync(file, svg, 'utf8');
  console.log(`${file}: ${nodes} boxes, ${width}x${height}, ${(svg.length / 1024).toFixed(0)} KB`);
}
