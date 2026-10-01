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

test('leaves a complex (list/map) tfvars value out of the resolved map rather than guessing', () => {
  const content = `
environment = "data_dev"
azs = ["eu-west-1a", "eu-west-1b"]
`;
  // azs is a list -> not a scalar resolveHclValue can resolve; omitted, not
  // silently stringified or half-parsed.
  assert.deepEqual(parseTfvars(content), { environment: 'data_dev' });
});
