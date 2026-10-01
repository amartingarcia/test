import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHclAttributes } from '../lib/parse/parse-hcl-attributes.mjs';

test('parses simple scalar attributes', () => {
  const body = `
  name    = "prod"
  version = "1.29"
  enabled = true
  count   = 3
`;
  const attrs = parseHclAttributes(body);
  assert.equal(attrs.name, '"prod"');
  assert.equal(attrs.version, '"1.29"');
  assert.equal(attrs.enabled, 'true');
  assert.equal(attrs.count, '3');
});

test('captures a nested object attribute as raw unparsed text', () => {
  const body = `
  eks_managed_node_groups = {
    default = {
      instance_types = ["m5.large"]
      min_size       = 1
    }
  }
  cluster_version = "1.29"
`;
  const attrs = parseHclAttributes(body);
  assert.match(attrs.eks_managed_node_groups, /default = \{/);
  assert.match(attrs.eks_managed_node_groups, /instance_types = \["m5\.large"\]/);
  assert.equal(attrs.cluster_version, '"1.29"');
});

test('captures a list attribute as raw text', () => {
  const body = `addons = ["vpc-cni", "coredns", "kube-proxy"]`;
  const attrs = parseHclAttributes(body);
  assert.equal(attrs.addons, '["vpc-cni", "coredns", "kube-proxy"]');
});

test('captures a variable reference as raw text (unresolved at this layer)', () => {
  const body = `version = var.eks_version`;
  const attrs = parseHclAttributes(body);
  assert.equal(attrs.version, 'var.eks_version');
});

test('ignores a nested block (not a key = value attribute) without crashing', () => {
  const body = `
  name = "prod"
  lifecycle {
    create_before_destroy = true
  }
`;
  const attrs = parseHclAttributes(body);
  assert.equal(attrs.name, '"prod"');
  assert.equal(attrs.lifecycle, undefined);
  assert.equal(attrs.create_before_destroy, undefined); // nested, not top-level
});

test('ignores comments', () => {
  const body = `
  # this is a comment with an = sign
  name = "prod" # trailing comment
`;
  const attrs = parseHclAttributes(body);
  assert.equal(attrs.name, '"prod"');
  assert.equal(Object.keys(attrs).length, 1);
});

test('returns an empty object for a body with no attributes', () => {
  assert.deepEqual(parseHclAttributes('  # nothing here\n'), {});
});
