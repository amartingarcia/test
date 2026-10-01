import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (graph, ...extra) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const file = path.join(dir, 'g.json');
  fs.writeFileSync(file, JSON.stringify(graph));
  const r = spawnSync(process.execPath, ['scripts/verify.mjs', '--graph', file, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
};
const base = { environment: 'x', entities: [{ id: 'a', kind: 'aws.vpc', parent: null }, { id: 'b', kind: 'aws.subnet', parent: 'a' }], edges: [{ from: 'b', to: 'a' }], coverage: {}, findings: [] };

test('a consistent graph passes', () => assert.equal(run(base).code, 0));

test('dangling edge, dangling parent and parent cycles fail with a hint', () => {
  const bad = { ...base, entities: [{ id: 'a', kind: 'aws.vpc', parent: 'b' }, { id: 'b', kind: 'aws.subnet', parent: 'a' }, { id: 'c', kind: 'aws.vpc', parent: 'zz' }], edges: [{ from: 'a', to: 'nope' }] };
  const { code, out } = run(bad);
  assert.equal(code, 1);
  const codes = out.issues.map((i) => i.code);
  for (const c of ['parent-cycle', 'dangling-parent', 'dangling-edge']) assert.ok(codes.includes(c), c);
  assert.ok(out.issues.every((i) => i.hint));
});

test('warnings pass unless --strict', () => {
  const g = { ...base, coverage: { r: { unmapped: ['aws_x.y'], unresolvedBoundaries: [] } } };
  assert.equal(run(g).code, 0);
  assert.equal(run(g, '--strict').code, 1);
});
