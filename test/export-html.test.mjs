import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildStandaloneHtml, bundleModules } from '../scripts/lib/build-standalone.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'viewer', 'data');
const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8'));
const graph = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, `${id}.json`), 'utf8'));
const payload = (html) => JSON.parse(/<script type="application\/json" id="infra-data">([\s\S]*?)<\/script>/.exec(html)[1]);

test('bundleModules drops imports and exports and keeps the code', () => {
  const out = bundleModules(["import { a } from './a.mjs';\nexport const b = 1;\nexport function c() {}\nexport { b };\n"]);
  assert.ok(!/\bimport\b|\bexport\b/.test(out));
  assert.match(out, /const b = 1;/);
  assert.match(out, /function c\(\)/);
});

test('standalone HTML is one file: no external requests, data round-trips, exactly two scripts', () => {
  const graphs = [{ id: 'platform_prod', label: 'platform / prod', graph: graph('platform_prod') }, { id: 'azure_prod', label: 'azure / prod', graph: graph('azure_prod') }];
  const html = buildStandaloneHtml({ graphs, catalog, title: 'My <diagram> & co' });
  assert.ok(!/(src|href)=["']?(https?:)?\/\//i.test(html), 'no external src/href');
  assert.ok(!/<link\b|@import|url\(\s*["']?https?:/i.test(html), 'no external css');
  assert.equal((html.match(/<script\b/g) ?? []).length, 2);
  assert.match(html, /<title>My &lt;diagram&gt; &amp; co<\/title>/);
  const data = payload(html);
  assert.deepEqual(data.graphs.map((g) => g.id), ['platform_prod', 'azure_prod']);
  assert.deepEqual(data.graphs[0].graph, graphs[0].graph);
  assert.equal(Object.keys(data.catalog.kinds).length, Object.keys(catalog.kinds).length);
});

test('the inlined bundle is valid script and exposes the renderer (no duplicate declarations)', () => {
  const html = buildStandaloneHtml({ graphs: [{ id: 'g', label: 'g', graph: graph('gcp_prod') }], catalog });
  const code = html.split('<script>')[1].split('</script>')[0];
  const bundleOnly = code.slice(0, code.indexOf('// Client code of the standalone HTML export'));
  const fn = new Function(`${bundleOnly}; return { renderSvg, paletteFor, buildDiagram, KIND_CLASS };`);
  const api = fn();
  const { svg } = api.renderSvg(graph('gcp_prod'), catalog, { preset: 'soft', theme: 'light' });
  assert.ok(svg.startsWith('<svg'));
  assert.doesNotThrow(() => new Function(code)); // whole script parses
});

test('hostile content in the graph cannot break out of the data block or the template', () => {
  const g = graph('gcp_prod');
  g.entities[0] = { ...g.entities[0], sourceAddress: '</script><script>alert(1)</script> $& $1 <!--  ' };
  const html = buildStandaloneHtml({ graphs: [{ id: 'g', label: '</script>', graph: g }], catalog });
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.equal((html.match(/<script\b/g) ?? []).length, 2);
  assert.equal(payload(html).graphs[0].graph.entities[0].sourceAddress, g.entities[0].sourceAddress);
});

test('CLI writes the file quickly, rejects unknown environments, and exports a custom graph', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-html-'));
  const out = path.join(tmp, 'all.html');
  const t0 = Date.now();
  execFileSync('node', [path.join(root, 'scripts', 'export-html.mjs'), '--out', out], { encoding: 'utf8' });
  assert.ok(Date.now() - t0 < 5000, 'fast');
  const envs = JSON.parse(fs.readFileSync(path.join(dataDir, 'environments.json'), 'utf8')).environments;
  assert.equal(payload(fs.readFileSync(out, 'utf8')).graphs.length, envs.length);

  assert.throws(() => execFileSync('node', [path.join(root, 'scripts', 'export-html.mjs'), '--env', 'nope', '--out', out], { stdio: 'pipe' }), /unknown environment/);

  const one = path.join(tmp, 'one.html');
  execFileSync('node', [path.join(root, 'scripts', 'export-html.mjs'), '--graph', path.join(dataDir, 'gcp_dev.json'), '--catalog', path.join(dataDir, 'catalog.json'), '--preset', 'neon', '--theme', 'light', '--out', one]);
  const data = payload(fs.readFileSync(one, 'utf8'));
  assert.deepEqual([data.graphs.length, data.preset, data.theme], [1, 'neon', 'light']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('export-svg CLI writes one valid vector SVG per environment', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-svg-'));
  execFileSync('node', [path.join(root, 'scripts', 'export-svg.mjs'), '--env', 'gcp_dev', '--env', 'oci_dev', '--preset', 'draft', '--theme', 'light', '--out-dir', tmp]);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['gcp_dev.svg', 'oci_dev.svg']);
  const svg = fs.readFileSync(path.join(tmp, 'gcp_dev.svg'), 'utf8');
  assert.ok(svg.startsWith('<svg') && svg.includes('data-preset="draft"') && svg.includes('data-theme="light"'));
  assert.ok(!/<image|data:image/.test(svg));
  fs.rmSync(tmp, { recursive: true, force: true });
});
