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

// --- lists: resolve only when EVERY element resolves; otherwise keep raw ---

test('resolves a list of string literals into an array', () => {
  assert.deepEqual(resolveHclValue('["vpc-cni", "coredns"]', {}), {
    resolved: true,
    value: ['vpc-cni', 'coredns'],
  });
});

test('resolves a mixed-scalar list and an empty list', () => {
  assert.deepEqual(resolveHclValue('[1, true, "x"]', {}), { resolved: true, value: [1, true, 'x'] });
  assert.deepEqual(resolveHclValue('[]', {}), { resolved: true, value: [] });
});

test('resolves a multi-line list with a trailing comma', () => {
  const raw = '[\n  "a",\n  "b",\n]';
  assert.deepEqual(resolveHclValue(raw, {}), { resolved: true, value: ['a', 'b'] });
});

test('resolves var references inside a list via the vars map', () => {
  assert.deepEqual(resolveHclValue('[var.region, "eu-west-1b"]', { region: 'eu-west-1a' }), {
    resolved: true,
    value: ['eu-west-1a', 'eu-west-1b'],
  });
});

test('does not split a list on commas inside strings or nested lists', () => {
  assert.deepEqual(resolveHclValue('["a,b", ["c", "d"]]', {}), {
    resolved: true,
    value: ['a,b', ['c', 'd']],
  });
});

test('leaves a whole list unresolved (raw kept) when any element is unresolvable', () => {
  const raw = '["ok", local.dynamic]';
  assert.deepEqual(resolveHclValue(raw, {}), { resolved: false, raw });
});

// --- objects: same rule, recursive ---

test('resolves a nested object literal into a plain object', () => {
  const raw = '{\n  default = {\n    min_size = 1\n    max_size = 3\n  }\n}';
  assert.deepEqual(resolveHclValue(raw, {}), {
    resolved: true,
    value: { default: { min_size: 1, max_size: 3 } },
  });
});

test('resolves a single-line comma-separated object and an empty object', () => {
  assert.deepEqual(resolveHclValue('{ a = 1, b = "x" }', {}), { resolved: true, value: { a: 1, b: 'x' } });
  assert.deepEqual(resolveHclValue('{}', {}), { resolved: true, value: {} });
});

test('resolves lists inside objects and var refs inside objects', () => {
  const raw = '{\n  instance_types = ["m5.large"]\n  version = var.v\n}';
  assert.deepEqual(resolveHclValue(raw, { v: '1.29' }), {
    resolved: true,
    value: { instance_types: ['m5.large'], version: '1.29' },
  });
});

test('leaves a whole object unresolved (raw kept) when any value is unresolvable', () => {
  const raw = '{\n  a = 1\n  b = local.x\n}';
  assert.deepEqual(resolveHclValue(raw, {}), { resolved: false, raw });
});

test('leaves an object unresolved when it uses quoted keys (not safely parseable here)', () => {
  const raw = '{\n  "kubernetes.io/role" = "x"\n}';
  assert.deepEqual(resolveHclValue(raw, {}), { resolved: false, raw });
});

test('leaves a for-expression unresolved rather than guessing', () => {
  const raw = '[for s in var.subnets : s.id]';
  assert.deepEqual(resolveHclValue(raw, { subnets: [] }), { resolved: false, raw });
});

test('leaves a string interpolation expression unresolved rather than guessing', () => {
  const raw = '"${var.env}-cluster"';
  assert.deepEqual(resolveHclValue(raw, { env: 'prod' }), { resolved: false, raw });
});

test('leaves a local.X reference unresolved (locals are not in scope for this layer)', () => {
  assert.deepEqual(resolveHclValue('local.name_prefix', {}), { resolved: false, raw: 'local.name_prefix' });
});

// --- conditional expressions: `cond ? a : b` with a resolvable condition ---

test('a conditional on a boolean var resolves to the chosen branch', () => {
  assert.deepEqual(resolveHclValue('var.enabled ? 1 : 0', { enabled: true }), { resolved: true, value: 1 });
  assert.deepEqual(resolveHclValue('var.enabled ? 1 : 0', { enabled: false }), { resolved: true, value: 0 });
  assert.deepEqual(resolveHclValue('true ? "a" : "b"', {}), { resolved: true, value: 'a' });
});

test('equality and negation are supported in the condition', () => {
  assert.deepEqual(resolveHclValue('var.env == "prod" ? 3 : 1', { env: 'prod' }), { resolved: true, value: 3 });
  assert.deepEqual(resolveHclValue('var.env == "prod" ? 3 : 1', { env: 'dev' }), { resolved: true, value: 1 });
  assert.deepEqual(resolveHclValue('var.env != "prod" ? 3 : 1', { env: 'dev' }), { resolved: true, value: 3 });
  assert.deepEqual(resolveHclValue('!var.enabled ? "off" : "on"', { enabled: false }), { resolved: true, value: 'off' });
});

test('nested conditionals associate to the right', () => {
  const raw = 'var.env == "prod" ? 3 : var.env == "stage" ? 2 : 1';
  assert.deepEqual(resolveHclValue(raw, { env: 'stage' }), { resolved: true, value: 2 });
  assert.deepEqual(resolveHclValue(raw, { env: 'dev' }), { resolved: true, value: 1 });
});

test('only the chosen branch has to resolve', () => {
  assert.deepEqual(resolveHclValue('var.on ? 1 : aws_thing.x.id', { on: true }), { resolved: true, value: 1 });
  assert.deepEqual(resolveHclValue('var.on ? 1 : aws_thing.x.id', { on: false }), { resolved: false, raw: 'var.on ? 1 : aws_thing.x.id' });
});

test('a condition that is unknown, or not a boolean, stays unresolved (never guessed)', () => {
  assert.equal(resolveHclValue('var.missing ? 1 : 0', {}).resolved, false);
  assert.equal(resolveHclValue('var.s ? 1 : 0', { s: 'true' }).resolved, false);
  assert.equal(resolveHclValue('aws_thing.x.enabled ? 1 : 0', {}).resolved, false);
});

test('? and : inside strings or brackets are not conditionals', () => {
  assert.deepEqual(resolveHclValue('"what? yes: no"', {}), { resolved: true, value: 'what? yes: no' });
  assert.equal(resolveHclValue('lookup(var.m, "a?b", 1)', { m: {} }).resolved, false);
});

test('two adjacent string literals are not mistaken for one string literal', () => {
  assert.equal(resolveHclValue('"a" == "b"', {}).resolved, false);
});
