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
import { inferPlacementFromReferences } from '../lib/compile/infer-placement.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const catalog = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'catalog', 'kinds.json'), 'utf8'));

const baseNetworkManifest = JSON.parse(
  await fs.readFile(path.join(__dirname, '..', 'examples', 'manifests', 'network.example.manifest.json'), 'utf8')
);

// The checked-in example keeps every boundary on the VPC. For the demo we
// refine it: a NAT gateway lives in a public subnet, and there is a third
// tier of subnets for data stores.
const networkManifest = structuredClone(baseNetworkManifest);
for (const rule of networkManifest.rules) {
  if (rule.entity.kind === 'aws.nat_gateway') rule.entity.boundary = 'aws.subnet.public';
}
const privateIdx = networkManifest.rules.findIndex((r) => r.entity.kind === 'aws.subnet.private');
networkManifest.rules.splice(privateIdx + 1, 0, {
  match: { type: 'aws_subnet', nameRegex: '^data' },
  entity: { kind: 'aws.subnet.data', idFrom: 'address', boundary: 'aws.vpc' },
});

const infraManifest = {
  repoId: 'infra',
  rules: [
    // Cross-repo relationships (cluster -> subnet, databases -> subnet, ...)
    // are declared as crossRepoLinks below, not as boundaries: a boundary only
    // resolves inside one repo.
    { match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } },
    { match: { type: 'aws_eks_node_group' }, entity: { kind: 'aws.eks.nodegroup', idFrom: 'name', boundary: 'aws.eks.cluster' } },
    // addons belong to the cluster (they are a property of it), not boxes of their own
    { match: { type: 'aws_eks_addon' }, entity: { kind: 'aws.eks.addon', idFrom: 'name', boundary: 'aws.eks.cluster', embed: true } },
    { match: { type: 'aws_iam_role', nameRegex: '^cluster' }, entity: { kind: 'aws.iam.role.cluster', idFrom: 'name' } },
    { match: { type: 'aws_iam_role', nameRegex: '^node' }, entity: { kind: 'aws.iam.role.node', idFrom: 'name' } },
    { match: { type: 'aws_iam_role', nameRegex: 'irsa$' }, entity: { kind: 'aws.iam.role.irsa', idFrom: 'name' } },
    { match: { type: 'aws_db_instance' }, entity: { kind: 'aws.rds.instance', idFrom: 'name' } },
    { match: { type: 'aws_docdb_cluster' }, entity: { kind: 'aws.docdb.cluster', idFrom: 'name' } },
  ],
};

// What runs on the cluster: a third repo (GitOps-style), Helm releases.
const gitopsManifest = {
  repoId: 'gitops',
  rules: [
    { match: { type: 'helm_release', nameRegex: '^orders' }, entity: { kind: 'k8s.release.service', idFrom: 'name' } },
    { match: { type: 'helm_release', nameRegex: '^report' }, entity: { kind: 'k8s.release.batch', idFrom: 'name' } },
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
		"[root] aws_subnet.data (expand)" [label = "aws_subnet.data", shape = "box"]
		"[root] aws_nat_gateway.main (expand)" [label = "aws_nat_gateway.main", shape = "box"]
		"[root] aws_internet_gateway.main (expand)" [label = "aws_internet_gateway.main", shape = "box"]
		"[root] aws_security_group.default (expand)" [label = "aws_security_group.default", shape = "box"]
		"[root] aws_subnet.public (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_subnet.private (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_subnet.data (expand)" -> "[root] aws_vpc.main (expand)"
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
		"[root] aws_iam_role.cluster (expand)" [label = "aws_iam_role.cluster", shape = "box"]
		"[root] aws_iam_role.node (expand)" [label = "aws_iam_role.node", shape = "box"]
		"[root] aws_iam_role.orders_api_irsa (expand)" [label = "aws_iam_role.orders_api_irsa", shape = "box"]
		"[root] aws_db_instance.orders (expand)" [label = "aws_db_instance.orders", shape = "box"]
		"[root] aws_docdb_cluster.reports (expand)" [label = "aws_docdb_cluster.reports", shape = "box"]
		"[root] aws_eks_node_group.default (expand)" -> "[root] aws_eks_cluster.this (expand)"
		"[root] aws_eks_addon.vpc_cni (expand)" -> "[root] aws_eks_cluster.this (expand)"
		"[root] aws_eks_addon.coredns (expand)" -> "[root] aws_eks_cluster.this (expand)"
		"[root] aws_eks_cluster.this (expand)" -> "[root] aws_iam_role.cluster (expand)"
		"[root] aws_eks_node_group.default (expand)" -> "[root] aws_iam_role.node (expand)"
	}
}
`;

const gitopsDot = `
digraph {
	subgraph "root" {
		"[root] helm_release.orders_api (expand)" [label = "helm_release.orders_api", shape = "box"]
		"[root] helm_release.report_job (expand)" [label = "helm_release.report_job", shape = "box"]
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

// Not extracted attribute-by-attribute beyond the top level: nested blocks
// (e.g. kubernetes `spec { }`) are out of scope, which is why the GitOps
// side uses helm_release (flat attributes) rather than kubernetes_deployment.
infraTfFiles.push({
  filePath: 'data.tf',
  content: `
resource "aws_iam_role" "cluster" {
  name = "prod-eks-cluster"
  path = "/"
}

resource "aws_iam_role" "node" {
  name = "prod-eks-node"
  path = "/"
}

resource "aws_iam_role" "orders_api_irsa" {
  name = "prod-orders-api-irsa"
  path = "/service-role/"
}

resource "aws_db_instance" "orders" {
  identifier           = "orders"
  engine               = "postgres"
  engine_version       = "16.3"
  instance_class       = var.db_instance_class
  allocated_storage    = 100
  multi_az             = true
  storage_encrypted    = true
  db_subnet_group_name = aws_db_subnet_group.data.name
}

resource "aws_docdb_cluster" "reports" {
  cluster_identifier  = "reports"
  engine_version      = "5.0.0"
  storage_encrypted   = true
  backup_retention_period = 7
}
`,
});
const infraVars = { eks_version: '1.29', db_instance_class: 'db.r6g.large' };

const gitopsTfFiles = [
  {
    filePath: 'releases.tf',
    content: `
resource "helm_release" "orders_api" {
  name      = "orders-api"
  chart     = "orders-api"
  version   = "1.8.2"
  namespace = "orders"
}

resource "helm_release" "report_job" {
  name      = "report-job"
  chart     = "batch-job"
  version   = "0.4.0"
  namespace = "reports"
}
`,
  },
];


const networkParsed = parseDotGraph(networkDot);
const infraParsed = parseDotGraph(infraDot);
const gitopsParsed = parseDotGraph(gitopsDot);

const compiled = compileEnvironmentGraph({
  environment: 'data_dev',
  repoGraphs: [
    { repoId: 'network', manifest: networkManifest, nodes: networkParsed.nodes, edges: networkParsed.edges },
    { repoId: 'infra', manifest: infraManifest, nodes: infraParsed.nodes, edges: infraParsed.edges },
    { repoId: 'gitops', manifest: gitopsManifest, nodes: gitopsParsed.nodes, edges: gitopsParsed.edges },
  ],
  crossRepoLinks: [
    // placement (containment) now comes from catalog/kinds.json
    // runtime dependencies
    { fromKind: 'k8s.release.service', toKind: 'aws.iam.role.irsa', label: 'assumes (IRSA)' },
    { fromKind: 'k8s.release.service', toKind: 'aws.rds.instance', label: 'SQL' },
    { fromKind: 'k8s.release.batch', toKind: 'aws.docdb.cluster', label: 'writes' },
  ],
  catalog,
  edgeLabels: [
    { fromKind: 'aws.eks.cluster', toKind: 'aws.iam.role.cluster', label: 'assumes' },
    { fromKind: 'aws.eks.nodegroup', toKind: 'aws.iam.role.node', label: 'assumes' },
  ],
});

// T7 glue: attach resolved attribute details (Layer A2) to each infra
// entity whose source address we can find a block for. Managed resources
// only (blockType "resource") — see the viewer's known limitations.
const sources = { infra: [infraTfFiles, infraVars], gitops: [gitopsTfFiles, {}] };
for (const entity of compiled.entities) {
  const source = sources[entity.repoId];
  if (!source) continue;
  const parsed = parseResourceAddress(entity.sourceAddress);
  if (!parsed) continue;
  const details = extractResourceDetails(source[0], { blockType: 'resource', labels: [parsed.type, parsed.name] }, source[1]);
  if (details) entity.details = details.attributes;
}

// Placement from what the source itself references (same-repo only): narrows
// what the catalog alone left ambiguous. Cross-repo cases, like this demo's,
// are fully handled by the catalog (exactly one candidate per kind).
{
  const { placements, unresolved } = inferPlacementFromReferences({
    entities: compiled.entities,
    files: { infra: infraTfFiles, gitops: gitopsTfFiles },
    vars: infraVars,
    catalog,
  });
  const byId = new Map(compiled.entities.map((e) => [e.id, e]));
  for (const { entityId, parent } of placements) byId.get(entityId).parent = parent;
  const placed = new Set(placements.map((p) => p.entityId));
  compiled.unresolvedPlacements = [
    ...compiled.unresolvedPlacements.filter((u) => !placed.has(u.entityId)),
    ...unresolved.filter((u) => !compiled.unresolvedPlacements.some((x) => x.entityId === u.entityId)),
  ];
}

const outPath = path.join(__dirname, '..', 'viewer', 'data', 'data_dev.json');
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(compiled, null, 2) + '\n', 'utf8');
// the viewer is served from viewer/ only, so it gets its own copy of the catalog
await fs.writeFile(path.join(path.dirname(outPath), 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`wrote ${outPath}`);
console.log(`entities: ${compiled.entities.length}, edges: ${compiled.edges.length}`);
if (Object.values(compiled.coverage).some((c) => c.unmapped.length || c.unresolvedBoundaries.length)) {
  console.log('coverage warnings:', JSON.stringify(compiled.coverage, null, 2));
}
if (compiled.unresolvedPlacements.length) console.log('unresolved placements:', compiled.unresolvedPlacements);
if (compiled.unresolvedCrossRepoLinks.length) {
  console.log('unresolved cross-repo links:', compiled.unresolvedCrossRepoLinks);
}
