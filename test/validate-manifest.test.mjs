import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateManifest } from '../lib/manifest/validate-manifest.mjs';

const validManifest = {
  repoId: 'network',
  rules: [
    { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } },
    { match: { type: 'aws_subnet', nameRegex: '^private' }, entity: { kind: 'aws.subnet.private', idFrom: 'address', boundary: 'vpc' } },
  ],
};

test('accepts a well-formed manifest', () => {
  assert.deepEqual(validateManifest(validManifest), []);
});

test('rejects a manifest missing repoId', () => {
  const errors = validateManifest({ rules: [] });
  assert.ok(errors.some((e) => e.includes('repoId')));
});

test('rejects a manifest where rules is not an array', () => {
  const errors = validateManifest({ repoId: 'network', rules: 'nope' });
  assert.ok(errors.some((e) => e.includes('rules')));
});

test('rejects a rule missing match', () => {
  const errors = validateManifest({ repoId: 'network', rules: [{ entity: { kind: 'x', idFrom: 'name' } }] });
  assert.ok(errors.some((e) => e.includes('rules[0].match')));
});

test('rejects a rule missing entity.kind', () => {
  const errors = validateManifest({ repoId: 'network', rules: [{ match: { type: 'aws_vpc' }, entity: { idFrom: 'name' } }] });
  assert.ok(errors.some((e) => e.includes('rules[0].entity.kind')));
});

test('rejects idFrom "literal" without an entity.id', () => {
  const errors = validateManifest({
    repoId: 'network',
    rules: [{ match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'literal' } }],
  });
  assert.ok(errors.some((e) => e.includes('rules[0].entity.id')));
});

test('rejects an unknown idFrom value', () => {
  const errors = validateManifest({
    repoId: 'network',
    rules: [{ match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'nonsense' } }],
  });
  assert.ok(errors.some((e) => e.includes('idFrom')));
});

test('rejects a match block with no recognized matcher keys', () => {
  const errors = validateManifest({
    repoId: 'network',
    rules: [{ match: {}, entity: { kind: 'aws.vpc', idFrom: 'name' } }],
  });
  assert.ok(errors.some((e) => e.includes('rules[0].match')));
});

test('reports every error, not just the first', () => {
  const errors = validateManifest({
    rules: [{ match: {}, entity: {} }],
  });
  assert.ok(errors.length >= 3);
});
