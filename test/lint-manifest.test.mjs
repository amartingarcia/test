import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintManifest, lintCatalog } from '../lib/manifest/lint-manifest.mjs';

const catalog = { kinds: { 'aws.vpc': {}, 'aws.subnet': { placement: { parentKinds: ['aws.vpc'] } } } };
const rule = (type, kind, extra = {}) => ({ match: { type }, entity: { kind, idFrom: 'name', ...extra } });

test('a clean manifest has no findings', () => {
  const manifest = { repoId: 'r', rules: [rule('aws_vpc', 'aws.vpc'), rule('aws_subnet', 'aws.subnet.private', { boundary: 'aws.vpc' })] };
  assert.deepEqual(lintManifest(manifest, catalog), []);
});

test('structural errors from validateManifest are reported as errors', () => {
  const findings = lintManifest({ repoId: '', rules: [] }, catalog);
  assert.equal(findings[0].level, 'error');
});

test('a kind with no catalog entry (exact or by prefix) is a warning', () => {
  const manifest = { repoId: 'r', rules: [rule('aws_thing', 'aws.thing')] };
  const findings = lintManifest(manifest, catalog);
  assert.deepEqual(findings.map((f) => [f.level, f.rule]), [['warn', 0]]);
  assert.match(findings[0].message, /aws\.thing.*no catalog entry/);
});

test('a boundary kind that no rule in the manifest produces is a warning (it may be cross-repo)', () => {
  const manifest = { repoId: 'r', rules: [rule('aws_subnet', 'aws.subnet.private', { boundary: 'aws.vpc' })] };
  const findings = lintManifest(manifest, catalog);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /boundary "aws\.vpc".*not produced by any rule/);
});

test('a rule shadowed by an earlier rule with the same match is a warning', () => {
  const manifest = { repoId: 'r', rules: [rule('aws_vpc', 'aws.vpc'), rule('aws_vpc', 'aws.vpc.other')] };
  const findings = lintManifest(manifest, { kinds: { 'aws.vpc': {} } });
  assert.ok(findings.some((f) => f.level === 'warn' && f.rule === 1 && /never matches/.test(f.message)));
});

test('ignore rules are not checked against the catalog', () => {
  const manifest = { repoId: 'r', rules: [{ match: { type: 'aws_eip' }, ignore: true }] };
  assert.deepEqual(lintManifest(manifest, catalog), []);
});

test('lintCatalog flags placement parent kinds that the catalog does not know', () => {
  const findings = lintCatalog({ kinds: { 'aws.subnet': { placement: { parentKinds: ['aws.vpc', 'aws.nope'] } }, 'aws.vpc': {} } });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /aws\.subnet.*aws\.nope/);
});

test('lintCatalog flags a non-numeric order and an unknown axis', () => {
  const findings = lintCatalog({ kinds: { 'a.b': { order: 'first', axis: 'diagonal' } } });
  assert.equal(findings.length, 2);
});
