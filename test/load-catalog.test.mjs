import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadCatalog } from '../lib/catalog/load-catalog.mjs';
import { lintCatalog } from '../lib/manifest/lint-manifest.mjs';

const tmp = async (files) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cat-'));
  for (const [n, c] of Object.entries(files)) await fs.writeFile(path.join(dir, n), JSON.stringify(c));
  return dir;
};

test('merges kinds and groups from every provider file', async () => {
  const dir = await tmp({ 'a.json': { kinds: { 'a.x': {} }, groups: { g: {} } }, 'b.json': { kinds: { 'b.y': {} } } });
  const c = await loadCatalog(dir);
  assert.deepEqual(Object.keys(c.kinds).sort(), ['a.x', 'b.y']);
  assert.deepEqual(Object.keys(c.groups), ['g']);
});

test('a kind defined twice is an error that names both files', async () => {
  const dir = await tmp({ 'a.json': { kinds: { k: {} } }, 'b.json': { kinds: { k: {} } } });
  await assert.rejects(loadCatalog(dir), /"k" is defined in both a\.json and b\.json/);
});

test('the shipped provider catalogs load and lint clean', async () => {
  const c = await loadCatalog(new URL('../catalog/providers', import.meta.url).pathname);
  assert.deepEqual(lintCatalog(c), []);
});
