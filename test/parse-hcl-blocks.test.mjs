import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHclBlocks } from '../lib/parse/parse-hcl-blocks.mjs';

test('parses a single resource block', () => {
  const hcl = `
resource "aws_eks_cluster" "this" {
  name    = "prod"
  version = "1.29"
}
`;
  const blocks = parseHclBlocks(hcl);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].blockType, 'resource');
  assert.deepEqual(blocks[0].labels, ['aws_eks_cluster', 'this']);
  assert.match(blocks[0].body, /name\s*=\s*"prod"/);
  assert.match(blocks[0].body, /version\s*=\s*"1\.29"/);
});

test('parses multiple top-level blocks of different kinds', () => {
  const hcl = `
variable "environment" {
  type = string
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

module "eks" {
  source  = "./modules/eks"
  version = var.eks_version
}
`;
  const blocks = parseHclBlocks(hcl);
  assert.deepEqual(
    blocks.map((b) => [b.blockType, ...b.labels]),
    [
      ['variable', 'environment'],
      ['resource', 'aws_vpc', 'main'],
      ['module', 'eks'],
    ]
  );
});

test('correctly handles nested braces inside a block body (e.g. a nested object attribute)', () => {
  const hcl = `
module "eks" {
  eks_managed_node_groups = {
    default = {
      instance_types = ["m5.large"]
      min_size       = 1
    }
  }
}
`;
  const blocks = parseHclBlocks(hcl);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].body, /eks_managed_node_groups = \{/);
  assert.match(blocks[0].body, /instance_types = \["m5\.large"\]/);
});

test('does not get confused by braces inside string literals', () => {
  const hcl = `
resource "aws_iam_role_policy" "example" {
  policy = "{\\"Version\\": \\"2012-10-17\\"}"
  name   = "example"
}
`;
  const blocks = parseHclBlocks(hcl);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].body, /name\s*=\s*"example"/);
});

test('ignores single-line comments when matching braces', () => {
  const hcl = `
resource "aws_vpc" "main" {
  # a comment mentioning a brace { just in case
  cidr_block = "10.0.0.0/16"
}
`;
  const blocks = parseHclBlocks(hcl);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].body, /cidr_block/);
});

test('returns an empty array for text with no blocks', () => {
  assert.deepEqual(parseHclBlocks('# just a comment\n'), []);
});
