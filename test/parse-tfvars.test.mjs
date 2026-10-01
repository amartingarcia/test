import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTfvars } from '../lib/parse/parse-tfvars.mjs';

test('parses scalar tfvars into a resolved values map', () => {
  const content = `
environment = "data_dev"
node_count  = 3
enabled     = true
`;
  assert.deepEqual(parseTfvars(content), {
    environment: 'data_dev',
    node_count: 3,
    enabled: true,
  });
});

test('ignores comments', () => {
  const content = `
# account var file
environment = "data_dev" # the account name
`;
  assert.deepEqual(parseTfvars(content), { environment: 'data_dev' });
});

test('returns an empty object for empty content', () => {
  assert.deepEqual(parseTfvars(''), {});
});

test('resolves list and map tfvars values made of literals', () => {
  const content = `
environment = "data_dev"
azs = ["eu-west-1a", "eu-west-1b"]
tags = {
  team = "platform"
  cost_center = 42
}
`;
  assert.deepEqual(parseTfvars(content), {
    environment: 'data_dev',
    azs: ['eu-west-1a', 'eu-west-1b'],
    tags: { team: 'platform', cost_center: 42 },
  });
});

test('leaves a tfvars value out of the resolved map when it cannot be fully resolved', () => {
  const content = `
environment = "data_dev"
dynamic_thing = [for x in [1, 2] : x * 2]
`;
  // omitted, not silently stringified or half-parsed
  assert.deepEqual(parseTfvars(content), { environment: 'data_dev' });
});
