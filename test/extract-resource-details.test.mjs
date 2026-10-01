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
