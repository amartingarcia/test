import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDotGraph } from '../lib/parse/parse-dot-graph.mjs';

test('parses the real two-resource DOT shape confirmed against actual terraform graph output', () => {
  // This exact node/edge shape is the one asserted against real `terraform
  // graph -type=plan` output in test/terraform-graph.test.mjs — kept in
  // sync intentionally so this fixture never drifts from observed reality.
  const dot = `
digraph {
	compound = "true"
	newrank = "true"
	subgraph "root" {
		"[root] terraform_data.a (expand)" [label = "terraform_data.a", shape = "box"]
		"[root] terraform_data.b (expand)" [label = "terraform_data.b", shape = "box"]
		"[root] terraform_data.b (expand)" -> "[root] terraform_data.a (expand)"
	}
}
`;

  const { nodes, edges } = parseDotGraph(dot);

  assert.equal(nodes.length, 2);
  assert.deepEqual(
    nodes.map((n) => n.address).sort(),
    ['terraform_data.a', 'terraform_data.b']
  );
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { from: 'terraform_data.b', to: 'terraform_data.a' });
});

test('filters out provider nodes/edges and keeps only resource nodes', () => {
  const dot = `
digraph {
	subgraph "root" {
		"[root] provider[\\"registry.terraform.io/hashicorp/aws\\"]" [label = "provider[\\"registry.terraform.io/hashicorp/aws\\"]", shape = "diamond"]
		"[root] aws_vpc.main (expand)" [label = "aws_vpc.main", shape = "box"]
		"[root] aws_subnet.public (expand)" [label = "aws_subnet.public", shape = "box"]
		"[root] aws_subnet.public (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_subnet.public (expand)" -> "[root] provider[\\"registry.terraform.io/hashicorp/aws\\"]"
	}
}
`;

  const { nodes, edges } = parseDotGraph(dot);

  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { from: 'aws_subnet.public', to: 'aws_vpc.main' });
});

test('resolves module-nested resource addresses with module path', () => {
  const dot = `
digraph {
	subgraph "root" {
		"[root] module.network.aws_vpc.main (expand)" [label = "module.network.aws_vpc.main", shape = "box"]
		"[root] module.eks.aws_eks_cluster.this (expand)" [label = "module.eks.aws_eks_cluster.this", shape = "box"]
		"[root] module.eks.aws_eks_cluster.this (expand)" -> "[root] module.network.aws_vpc.main (expand)"
	}
}
`;

  const { nodes, edges } = parseDotGraph(dot);

  const eksNode = nodes.find((n) => n.address === 'module.eks.aws_eks_cluster.this');
  assert.ok(eksNode);
  assert.deepEqual(eksNode.modulePath, ['eks']);
  assert.equal(eksNode.type, 'aws_eks_cluster');
  assert.equal(eksNode.name, 'this');

  assert.deepEqual(edges[0], {
    from: 'module.eks.aws_eks_cluster.this',
    to: 'module.network.aws_vpc.main',
  });
});

test('registers an edge endpoint as a node even without an explicit label line', () => {
  // terraform graph sometimes points an edge at a node whose own `[label =
  // ...]` declaration line was filtered out upstream (e.g. truncated
  // fixtures); the parser must not silently drop that endpoint.
  const dot = `
digraph {
	subgraph "root" {
		"[root] aws_subnet.public (expand)" [label = "aws_subnet.public", shape = "box"]
		"[root] aws_subnet.public (expand)" -> "[root] aws_vpc.main (expand)"
	}
}
`;

  const { nodes, edges } = parseDotGraph(dot);

  assert.deepEqual(
    nodes.map((n) => n.address).sort(),
    ['aws_subnet.public', 'aws_vpc.main']
  );
  assert.equal(edges.length, 1);
});

test('returns empty nodes/edges for a graph with no resources', () => {
  const dot = `
digraph {
	subgraph "root" {
		"[root] provider[\\"registry.terraform.io/hashicorp/aws\\"]" [label = "provider[\\"registry.terraform.io/hashicorp/aws\\"]", shape = "diamond"]
	}
}
`;

  const { nodes, edges } = parseDotGraph(dot);
  assert.deepEqual(nodes, []);
  assert.deepEqual(edges, []);
});
