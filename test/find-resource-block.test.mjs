import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findResourceBlock } from '../lib/extract/find-resource-block.mjs';

const files = [
  {
    filePath: 'vpc.tf',
    content: `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
`,
  },
  {
    filePath: 'eks.tf',
    content: `
resource "aws_eks_cluster" "this" {
  name    = "prod"
  version = "1.29"
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "vpc-cni"
}
`,
  },
];

test('finds a resource block by type + name across multiple files', () => {
  const result = findResourceBlock(files, { blockType: 'resource', labels: ['aws_eks_cluster', 'this'] });
  assert.equal(result.filePath, 'eks.tf');
  assert.match(result.block.body, /version\s*=\s*"1\.29"/);
});

test('finds a resource block in an earlier file without scanning the rest unnecessarily', () => {
  const result = findResourceBlock(files, { blockType: 'resource', labels: ['aws_vpc', 'main'] });
  assert.equal(result.filePath, 'vpc.tf');
});

test('returns null when no file has a matching block', () => {
  const result = findResourceBlock(files, { blockType: 'resource', labels: ['aws_rds_cluster', 'missing'] });
  assert.equal(result, null);
});

test('distinguishes blocks by blockType as well as labels', () => {
  const result = findResourceBlock(files, { blockType: 'module', labels: ['aws_vpc', 'main'] });
  assert.equal(result, null); // same labels exist, but as a "resource" block, not "module"
});
