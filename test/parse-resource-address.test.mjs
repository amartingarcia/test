import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseResourceAddress } from '../lib/parse/parse-resource-address.mjs';

test('parses a bare resource address', () => {
  assert.deepEqual(parseResourceAddress('aws_vpc.main'), {
    address: 'aws_vpc.main',
    modulePath: [],
    isData: false,
    type: 'aws_vpc',
    name: 'main',
    index: null,
  });
});

test('parses a resource address nested in one module', () => {
  const result = parseResourceAddress('module.network.aws_vpc.main');
  assert.deepEqual(result.modulePath, ['network']);
  assert.equal(result.type, 'aws_vpc');
  assert.equal(result.name, 'main');
});

test('parses a resource address nested in two modules', () => {
  const result = parseResourceAddress('module.network.module.subnets.aws_subnet.private');
  assert.deepEqual(result.modulePath, ['network', 'subnets']);
  assert.equal(result.type, 'aws_subnet');
  assert.equal(result.name, 'private');
});

test('parses a data source address', () => {
  const result = parseResourceAddress('data.aws_availability_zones.available');
  assert.equal(result.isData, true);
  assert.equal(result.type, 'aws_availability_zones');
  assert.equal(result.name, 'available');
});

test('parses a data source nested in a module', () => {
  const result = parseResourceAddress('module.network.data.aws_caller_identity.current');
  assert.deepEqual(result.modulePath, ['network']);
  assert.equal(result.isData, true);
  assert.equal(result.type, 'aws_caller_identity');
  assert.equal(result.name, 'current');
});

test('parses a numeric count index', () => {
  const result = parseResourceAddress('aws_instance.worker[0]');
  assert.equal(result.index, 0);
});

test('parses a for_each string key index', () => {
  const result = parseResourceAddress('aws_instance.worker["primary"]');
  assert.equal(result.index, 'primary');
});

test('returns null for a provider node', () => {
  assert.equal(parseResourceAddress('provider["registry.terraform.io/hashicorp/aws"]'), null);
});

test('returns null for a bare module boundary node (no resource suffix)', () => {
  assert.equal(parseResourceAddress('module.network'), null);
});

test('returns null for a var/local/output reference node', () => {
  assert.equal(parseResourceAddress('var.environment'), null);
  assert.equal(parseResourceAddress('local.name_prefix'), null);
  assert.equal(parseResourceAddress('output.vpc_id'), null);
});

test('returns null for a meta node', () => {
  assert.equal(parseResourceAddress('meta.count-boundary (EachMode fixup)'), null);
});
