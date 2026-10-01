#!/usr/bin/env node
// Builds a synthetic sample compiled graph for the viewer (viewer/index.html)
// to render. Uses invented resource data, never real repo content — see the
// hard constraint in odd/tasks/terraform-infra-diagram.md.
//
// Run: node scripts/build-sample-data.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDotGraph } from '../lib/parse/parse-dot-graph.mjs';
import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';
import { extractResourceDetails } from '../lib/extract/extract-resource-details.mjs';
import { parseResourceAddress } from '../lib/parse/parse-resource-address.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const networkManifest = JSON.parse(
  await fs.readFile(path.join(__dirname, '..', 'examples', 'manifests', 'network.example.manifest.json'), 'utf8')
);

const infraManifest = {
  repoId: 'infra',
  rules: [
    // No `boundary: 'aws.vpc'` here on purpose: boundary only resolves
    // within the same repo (see compile-environment-graph.mjs); the VPC
    // lives in the network repo, so that relationship is expressed via
    // crossRepoLinks below instead (an edge, not containment/nesting —
    // cross-repo nesting isn't supported yet, see the task doc backlog
    // note this script's output prompted).
    { match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } },
    { match: { type: 'aws_eks_node_group' }, entity: { kind: 'aws.eks.nodegroup', idFrom: 'name', boundary: 'aws.eks.cluster' } },
    { match: { type: 'aws_eks_addon' }, entity: { kind: 'aws.eks.addon', idFrom: 'name', boundary: 'aws.eks.cluster' } },
  ],
};

// Synthetic DOT graphs (hand-written, same shape terraform graph emits —
// see test/parse-dot-graph.test.mjs for the confirmed real shape)
const networkDot = `
digraph {
	subgraph "root" {
		"[root] aws_vpc.main (expand)" [label = "aws_vpc.main", shape = "box"]
		"[root] aws_subnet.public (expand)" [label = "aws_subnet.public", shape = "box"]
		"[root] aws_subnet.private (expand)" [label = "aws_subnet.private", shape = "box"]
		"[root] aws_nat_gateway.main (expand)" [label = "aws_nat_gateway.main", shape = "box"]
		"[root] aws_internet_gateway.main (expand)" [label = "aws_internet_gateway.main", shape = "box"]
		"[root] aws_security_group.default (expand)" [label = "aws_security_group.default", shape = "box"]
		"[root] aws_subnet.public (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_subnet.private (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_nat_gateway.main (expand)" -> "[root] aws_subnet.public (expand)"
		"[root] aws_internet_gateway.main (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_security_group.default (expand)" -> "[root] aws_vpc.main (expand)"
	}
}
`;

const infraDot = `
digraph {
	subgraph "root" {
		"[root] aws_eks_cluster.this (expand)" [label = "aws_eks_cluster.this", shape = "box"]
		"[root] aws_eks_node_group.default (expand)" [label = "aws_eks_node_group.default", shape = "box"]
		"[root] aws_eks_addon.vpc_cni (expand)" [label = "aws_eks_addon.vpc_cni", shape = "box"]
		"[root] aws_eks_addon.coredns (expand)" [label = "aws_eks_addon.coredns", shape = "box"]
		"[root] aws_eks_node_group.default (expand)" -> "[root] aws_eks_cluster.this (expand)"
		"[root] aws_eks_addon.vpc_cni (expand)" -> "[root] aws_eks_cluster.this (expand)"
		"[root] aws_eks_addon.coredns (expand)" -> "[root] aws_eks_cluster.this (expand)"
	}
}
`;

// Synthetic .tf source for the attribute drill-down demo (Layer A2)
const infraTfFiles = [
  {
    filePath: 'eks.tf',
    content: `
resource "aws_eks_cluster" "this" {
  name    = "prod-cluster"
  version = var.eks_version
}

resource "aws_eks_node_group" "default" {
  cluster_name   = aws_eks_cluster.this.name
  node_group_name = "default"
  instance_types = ["m5.large", "m5a.large"]
  capacity_type  = "ON_DEMAND"
  scaling_config = {
    min_size     = 2
    max_size     = 6
    desired_size = 3
  }
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name  = aws_eks_cluster.this.name
  addon_name    = "vpc-cni"
  addon_version = "v1.18.1-eksbuild.1"
}

resource "aws_eks_addon" "coredns" {
  cluster_name  = aws_eks_cluster.this.name
  addon_name    = "coredns"
  addon_version = "v1.11.1-eksbuild.9"
}
`,
  },
];
const infraVars = { eks_version: '1.29' };

const networkParsed = parseDotGraph(networkDot);
const infraParsed = parseDotGraph(infraDot);

const compiled = compileEnvironmentGraph({
  environment: 'data_dev',
  repoGraphs: [
    { repoId: 'network', manifest: networkManifest, nodes: networkParsed.nodes, edges: networkParsed.edges },
    { repoId: 'infra', manifest: infraManifest, nodes: infraParsed.nodes, edges: infraParsed.edges },
  ],
  crossRepoLinks: [{ fromKind: 'aws.eks.cluster', toKind: 'aws.vpc', label: 'runs in' }],
});

// T7 glue: attach resolved attribute details (Layer A2) to each infra
// entity whose source address we can find a block for. Managed resources
// only (blockType "resource") — see the viewer's known limitations.
for (const entity of compiled.entities) {
  if (entity.repoId !== 'infra') continue;
  const parsed = parseResourceAddress(entity.sourceAddress);
  if (!parsed) continue;
  const details = extractResourceDetails(infraTfFiles, { blockType: 'resource', labels: [parsed.type, parsed.name] }, infraVars);
  if (details) entity.details = details.attributes;
}

const outPath = path.join(__dirname, '..', 'viewer', 'data', 'data_dev.json');
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(compiled, null, 2) + '\n', 'utf8');

console.log(`wrote ${outPath}`);
console.log(`entities: ${compiled.entities.length}, edges: ${compiled.edges.length}`);
if (Object.values(compiled.coverage).some((c) => c.unmapped.length || c.unresolvedBoundaries.length)) {
  console.log('coverage warnings:', JSON.stringify(compiled.coverage, null, 2));
}
if (compiled.unresolvedCrossRepoLinks.length) {
  console.log('unresolved cross-repo links:', compiled.unresolvedCrossRepoLinks);
}
