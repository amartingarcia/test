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

// Found against futurice/terraform-examples (aws_vpc_msk): function calls with
// spaces/newlines were truncated at the first whitespace, and `1 + 2` was
// captured as just `1` (which then resolved to the number 1 — a silent guess).
test('captures a multi-token expression up to the end of the line, not the first space', () => {
  const attrs = parseHclAttributes('a = 1 + 2\nb = var.x ? "y" : "z"\nc = length(var.list)');
  assert.equal(attrs.a, '1 + 2');
  assert.equal(attrs.b, 'var.x ? "y" : "z"');
  assert.equal(attrs.c, 'length(var.list)');
});

test('captures a function call spanning several lines', () => {
  const attrs = parseHclAttributes('tags = merge(\n  var.tags,\n  { Name = "x" }\n)\nnext = 1');
  assert.equal(attrs.tags, 'merge(\n  var.tags,\n  { Name = "x" }\n)');
  assert.equal(attrs.next, '1');
});

test('captures a heredoc body whole, up to its terminator', () => {
  const attrs = parseHclAttributes('policy = <<EOF\n{ "a": "b" }\nEOF\nafter = 2');
  assert.equal(attrs.policy, '<<EOF\n{ "a": "b" }\nEOF');
  assert.equal(attrs.after, '2');
});

test('supports indented heredocs (<<-TAG)', () => {
  const attrs = parseHclAttributes('policy = <<-EOT\n  hello\n  EOT\nafter = 2');
  assert.equal(attrs.policy, '<<-EOT\n  hello\n  EOT');
  assert.equal(attrs.after, '2');
});

import { parseHclNestedBlocks } from '../lib/parse/parse-hcl-attributes.mjs';

test('parseHclNestedBlocks returns nested blocks (labeled or not) and ignores object/heredoc attribute values', () => {
  const body = `
  name = "x"
  tags = {
    a = 1
  }
  vpc_config {
    subnet_ids = [aws_subnet.a.id]
    inner {
      z = 1
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
  policy = <<EOF
  { "a": 1 }
EOF
`;
  const blocks = parseHclNestedBlocks(body);
  assert.deepEqual(blocks.map((b) => [b.type, b.labels]), [
    ['vpc_config', []],
    ['ingress', []],
    ['ingress', []],
    ['rule', ['r1']],
  ]);
  assert.match(blocks[0].body, /subnet_ids = \[aws_subnet\.a\.id\]/);
  assert.match(blocks[0].body, /inner \{/);
});
