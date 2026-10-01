import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractResourceDetails } from '../lib/extract/extract-resource-details.mjs';

const files = [
  {
    filePath: 'eks.tf',
    content: `
resource "aws_eks_cluster" "this" {
  name            = "prod"
  version         = var.eks_version
  endpoint_access = "private"
  tags = {
    team = "platform"
  }
  role_arn = aws_iam_role.cluster.arn
}
`,
  },
];

test('resolves literal/var/object attributes and leaves references unresolved with raw text kept', () => {
  const result = extractResourceDetails(files, { blockType: 'resource', labels: ['aws_eks_cluster', 'this'] }, { eks_version: '1.29' });

  assert.equal(result.filePath, 'eks.tf');
  assert.deepEqual(result.attributes.name, { resolved: true, value: 'prod' });
  assert.deepEqual(result.attributes.version, { resolved: true, value: '1.29' }); // resolved via var
  assert.deepEqual(result.attributes.endpoint_access, { resolved: true, value: 'private' });
  // an object of literals now resolves into a plain object...
  assert.deepEqual(result.attributes.tags, { resolved: true, value: { team: 'platform' } });
  // ...while a cross-resource reference stays unresolved, raw text kept
  assert.deepEqual(result.attributes.role_arn, { resolved: false, raw: 'aws_iam_role.cluster.arn' });
});

test('limits output to requested detailFields when provided', () => {
  const result = extractResourceDetails(
    files,
    { blockType: 'resource', labels: ['aws_eks_cluster', 'this'] },
    { eks_version: '1.29' },
    { detailFields: ['version'] }
  );

  assert.deepEqual(Object.keys(result.attributes), ['version']);
});

test('returns null when the target block is not found in any file', () => {
  const result = extractResourceDetails(files, { blockType: 'resource', labels: ['aws_vpc', 'missing'] }, {});
  assert.equal(result, null);
});

const nestedFiles = [
  {
    filePath: 'eks.tf',
    content: `
resource "aws_eks_cluster" "this" {
  name = "prod"
  vpc_config {
    subnet_ids              = [aws_subnet.private.id]
    endpoint_private_access = true
    inner {
      depth = 2
    }
  }
  ingress {
    from_port = 80
  }
  ingress {
    from_port = 443
  }
  rule "r1" {
    k = 2
  }
  lifecycle {
    prevent_destroy = true
  }
}
`,
  },
];
const nestedTarget = { blockType: 'resource', labels: ['aws_eks_cluster', 'this'] };

test('flattens nested blocks into dotted keys; references inside stay unresolved with raw text', () => {
  const a = extractResourceDetails(nestedFiles, nestedTarget, {}).attributes;
  assert.deepEqual(a['vpc_config.endpoint_private_access'], { resolved: true, value: true });
  assert.deepEqual(a['vpc_config.subnet_ids'], { resolved: false, raw: '[aws_subnet.private.id]' });
  assert.deepEqual(a['vpc_config.inner.depth'], { resolved: true, value: 2 });
});

test('repeated nested blocks are indexed; labeled ones carry their label', () => {
  const a = extractResourceDetails(nestedFiles, nestedTarget, {}).attributes;
  assert.deepEqual(a['ingress[0].from_port'], { resolved: true, value: 80 });
  assert.deepEqual(a['ingress[1].from_port'], { resolved: true, value: 443 });
  assert.deepEqual(a['rule.r1.k'], { resolved: true, value: 2 });
});

test('meta blocks (lifecycle, provisioner, connection) are not configuration', () => {
  const a = extractResourceDetails(nestedFiles, nestedTarget, {}).attributes;
  assert.equal(Object.keys(a).some((k) => k.startsWith('lifecycle')), false);
});

test('detailFields can select a dotted nested key', () => {
  const result = extractResourceDetails(nestedFiles, nestedTarget, {}, { detailFields: ['vpc_config.subnet_ids'] });
  assert.deepEqual(Object.keys(result.attributes), ['vpc_config.subnet_ids']);
});

import { entityDetails } from '../lib/extract/extract-resource-details.mjs';

test('entityDetails drops meta-arguments (count, for_each, depends_on, provider) but keeps real attributes', () => {
  const attrs = { count: { resolved: true, value: 1 }, for_each: { resolved: false, raw: 'var.x' }, depends_on: { resolved: false, raw: '[a]' }, provider: { resolved: false, raw: 'aws.x' }, name: { resolved: true, value: 'n' }, 'dynamic.taint.content.key': { resolved: false, raw: 'x' } };
  assert.deepEqual(Object.keys(entityDetails(attrs)).sort(), ['dynamic.taint.content.key', 'name']);
});
