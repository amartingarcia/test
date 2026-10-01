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
}
`,
  },
];

test('resolves scalar attributes and leaves complex ones unresolved with raw text kept', () => {
  const result = extractResourceDetails(files, { blockType: 'resource', labels: ['aws_eks_cluster', 'this'] }, { eks_version: '1.29' });

  assert.equal(result.filePath, 'eks.tf');
  assert.deepEqual(result.attributes.name, { resolved: true, value: 'prod' });
  assert.deepEqual(result.attributes.version, { resolved: true, value: '1.29' }); // resolved via var
  assert.deepEqual(result.attributes.endpoint_access, { resolved: true, value: 'private' });
  assert.equal(result.attributes.tags.resolved, false);
  assert.match(result.attributes.tags.raw, /team = "platform"/);
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
