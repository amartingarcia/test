import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSvg, PALETTES, PRESETS, paletteFor } from '../viewer/render-svg.mjs';
import { buildDiagram, layoutDiagram } from '../viewer/diagram-model.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'viewer', 'data');
const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8'));
const envs = JSON.parse(fs.readFileSync(path.join(dataDir, 'environments.json'), 'utf8')).environments;
const load = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, `${id}.json`), 'utf8'));

/** Minimal well-formedness check: balanced tags, quoted attributes, no stray ampersands. */
function assertWellFormed(svg) {
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(svg))) {
    const between = svg.slice(last, m.index);
    assert.ok(!/[<>]/.test(between), `stray angle bracket near: ${between.slice(0, 60)}`);
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(between), `unescaped ampersand near: ${between.slice(0, 60)}`);
    last = re.lastIndex;
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`);
    else stack.push(m[2]);
  }
  assert.equal(stack.length, 0, `unclosed: ${stack.join(',')}`);
  assert.ok(svg.trim().startsWith('<svg') && svg.trim().endsWith('</svg>'));
}

test('every sample environment renders as a well-formed, purely vector SVG', () => {
  for (const { id } of envs) {
    const graph = load(id);
    const { svg, nodes, edges } = renderSvg(graph, catalog, { preset: 'blueprint', theme: 'dark' });
    assertWellFormed(svg);
    assert.ok(nodes > 0, id);
    assert.ok(!/<image|data:image|<script|foreignObject|<style/.test(svg), `${id}: not pure vector`);
    // one card per leaf, one path per drawn link
    const { nodes: ns, edges: es } = buildDiagram(graph, catalog);
    const parents = new Set(ns.map((n) => n.parent).filter(Boolean));
    assert.equal((svg.match(/class="n"/g) ?? []).length, ns.filter((n) => !parents.has(n.id)).length, `${id}: cards`);
    assert.equal((svg.match(/class="c"/g) ?? []).length, parents.size, `${id}: containers`);
    assert.equal((svg.match(/class="e"/g) ?? []).length, es.length, `${id}: links`);
  }
});

test('all four presets in light and dark render, and look different', () => {
  const graph = load('platform_prod');
  const seen = new Set();
  for (const preset of Object.keys(PRESETS)) {
    for (const theme of ['light', 'dark']) {
      const { svg } = renderSvg(graph, catalog, { preset, theme });
      assertWellFormed(svg);
      seen.add(svg);
    }
  }
  assert.equal(seen.size, 8);
});

test('names with markup characters are escaped, never injected', () => {
  const graph = { environment: 'x', entities: [{ id: 'r:aws.vpc:<b>&"x"</b>', kind: 'aws.vpc', parent: null, repoId: 'r', sourceAddress: 'aws_vpc.x' }], edges: [], coverage: {} };
  const { svg } = renderSvg(graph, catalog, { title: 'a<b>&"c' });
  assertWellFormed(svg);
  assert.ok(!svg.includes('<b>'));
});

test('an empty graph still gives a valid SVG', () => {
  const { svg } = renderSvg({ entities: [], edges: [] }, catalog);
  assertWellFormed(svg);
});

test('layout: children sit inside their container and siblings never overlap', () => {
  for (const { id } of envs) {
    const { nodes } = buildDiagram(load(id), catalog);
    const { boxes } = layoutDiagram(nodes, catalog, {});
    const byParent = new Map();
    for (const n of nodes) {
      const b = boxes[n.id];
      assert.ok(b, `${id}: ${n.id} has a box`);
      if (n.parent && boxes[n.parent]) {
        const p = boxes[n.parent];
        assert.ok(b.x >= p.x && b.y >= p.y && b.x + b.w <= p.x + p.w + 0.5 && b.y + b.h <= p.y + p.h + 0.5, `${id}: ${n.id} inside ${n.parent}`);
      }
      const key = n.parent ?? '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(b);
    }
    for (const list of byParent.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const c = list[j];
        const overlap = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
        assert.ok(!overlap, `${id}: siblings overlap`);
      }
    }
  }
});

test('PALETTES mirror the CSS tokens of viewer/index.html (no drift between the page and the export)', () => {
  const css = fs.readFileSync(path.join(root, 'viewer', 'index.html'), 'utf8');
  const TOKENS = ['bg', 'border', 'text', 'muted', 'node', 'hit', 'net', 'compute', 'eks', 'k8s', 'data', 'iam', 'cfg', 'edgeapp', 'def'];
  const norm = (v) => v.trim().replace(/\s+/g, '').toLowerCase();
  for (const preset of Object.keys(PRESETS)) {
    for (const theme of ['dark', 'light']) {
      const re = new RegExp(`:root\\[data-preset="${preset}"\\]\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`);
      const block = re.exec(css)?.[1];
      assert.ok(block, `CSS block for ${preset}/${theme}`);
      const pal = paletteFor(preset, theme);
      for (const t of TOKENS) {
        const m = new RegExp(`--${t}:\\s*([^;]+);`).exec(block);
        assert.ok(m, `--${t} in ${preset}/${theme}`);
        assert.equal(norm(pal[t]), norm(m[1]), `${preset}/${theme} --${t}`);
      }
    }
  }
  assert.equal(Object.keys(PALETTES).length, 8);
});
