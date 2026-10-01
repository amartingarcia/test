import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHclValue } from '../lib/parse/resolve-hcl-value.mjs';

test('resolves a quoted string literal', () => {
  assert.deepEqual(resolveHclValue('"1.29"', {}), { resolved: true, value: '1.29' });
});

test('resolves a quoted string literal with an escaped quote', () => {
  assert.deepEqual(resolveHclValue('"say \\"hi\\""', {}), { resolved: true, value: 'say "hi"' });
});

test('resolves a bare integer', () => {
  assert.deepEqual(resolveHclValue('3', {}), { resolved: true, value: 3 });
});

test('resolves a bare negative/decimal number', () => {
  assert.deepEqual(resolveHclValue('-1.5', {}), { resolved: true, value: -1.5 });
});

test('resolves true/false/null literals', () => {
  assert.deepEqual(resolveHclValue('true', {}), { resolved: true, value: true });
  assert.deepEqual(resolveHclValue('false', {}), { resolved: true, value: false });
  assert.deepEqual(resolveHclValue('null', {}), { resolved: true, value: null });
});

test('resolves a var.X reference against the provided vars map', () => {
  const vars = { eks_version: '1.29' };
  assert.deepEqual(resolveHclValue('var.eks_version', vars), { resolved: true, value: '1.29' });
});

test('leaves a var.X reference unresolved when the var is not in the map', () => {
  const result = resolveHclValue('var.unknown_var', {});
  assert.deepEqual(result, { resolved: false, raw: 'var.unknown_var' });
});

test('leaves a nested object expression unresolved, keeping the raw text', () => {
  const raw = '{\n  default = {\n    min_size = 1\n  }\n}';
  assert.deepEqual(resolveHclValue(raw, {}), { resolved: false, raw });
});

test('leaves a list expression unresolved, keeping the raw text', () => {
  const raw = '["vpc-cni", "coredns"]';
  assert.deepEqual(resolveHclValue(raw, {}), { resolved: false, raw });
});

test('leaves a string interpolation expression unresolved rather than guessing', () => {
  const raw = '"${var.env}-cluster"';
  assert.deepEqual(resolveHclValue(raw, { env: 'prod' }), { resolved: false, raw });
});

test('leaves a local.X reference unresolved (locals are not in scope for this layer)', () => {
  assert.deepEqual(resolveHclValue('local.name_prefix', {}), { resolved: false, raw: 'local.name_prefix' });
});
