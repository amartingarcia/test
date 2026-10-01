#!/usr/bin/env node
// Builds viewer/data/platform_prod.json from the SYNTHETIC Terraform in
// examples/sample-platform/ (invented values, never real repo content).
//
// Unlike build-sample-data.mjs (hand-written DOT), the DOT graph here is
// derived from the .tf references, the way `terraform graph` derives its
// dependency edges. Placement (which subnet/VPC something lives in) is then
// inferred from those same references, with the catalog as fallback.
//
// Run: node scripts/build-platform-sample.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDotGraph } from '../lib/parse/parse-dot-graph.mjs';
import { parseHclBlocks } from '../lib/parse/parse-hcl-blocks.mjs';
import { parseResourceAddress } from '../lib/parse/parse-resource-address.mjs';
import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';
import { inferPlacementFromReferences, referencesOf } from '../lib/compile/infer-placement.mjs';
import { extractResourceDetails } from '../lib/extract/extract-resource-details.mjs';
import { validateManifest } from '../lib/manifest/validate-manifest.mjs';
import { parseTfvars } from '../lib/parse/parse-tfvars.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'kinds.json'), 'utf8'));

const platformDir = path.join(root, 'examples', 'sample-platform');
const platformFiles = await Promise.all(
  (await fs.readdir(platformDir)).filter((f) => f.endsWith('.tf')).sort()
    .map(async (f) => ({ filePath: f, content: await fs.readFile(path.join(platformDir, f), 'utf8') }))
);
const envDir = path.join(platformDir, 'envs');

const ent = (type, kind, extra = {}, nameRegex) => ({
  match: nameRegex ? { type, nameRegex } : { type },
  entity: { kind, idFrom: 'name', ...extra },
});
const ignore = (type) => ({ match: { type }, ignore: true });

// No boundaries on purpose: with two VPCs a boundary would be ambiguous.
// Where things live comes from references (vpc_id, subnet_id, ...) + the catalog.
const platformManifest = {
  repoId: 'platform',
  rules: [
    ent('aws_vpc', 'aws.vpc'),
    ent('aws_vpc_peering_connection', 'aws.vpc_peering'),
    ent('aws_subnet', 'aws.subnet.public', {}, 'public'),
    ent('aws_subnet', 'aws.subnet.private', {}, 'private'),
    ent('aws_subnet', 'aws.subnet.data', {}, 'data'),
    ent('aws_internet_gateway', 'aws.internet_gateway'),
    ent('aws_nat_gateway', 'aws.nat_gateway'),
    ent('aws_security_group', 'aws.security_group'),
    ent('aws_lb', 'aws.lb'),
    ent('aws_instance', 'aws.ec2.instance'),
    ent('aws_eks_cluster', 'aws.eks.cluster'),
    ent('aws_eks_node_group', 'aws.eks.nodegroup', { boundary: 'aws.eks.cluster' }),
    ent('aws_eks_addon', 'aws.eks.addon', { boundary: 'aws.eks.cluster', embed: true }),
    ent('aws_iam_role', 'aws.iam.role.cluster', {}, '^cluster'),
    ent('aws_iam_role', 'aws.iam.role.node', {}, '^node'),
    ent('aws_iam_role', 'aws.iam.role.irsa', {}, 'irsa$'),
    ent('aws_iam_role', 'aws.iam.role.ec2', {}, '^ec2'),
    ent('aws_db_instance', 'aws.rds.instance'),
    ent('aws_docdb_cluster', 'aws.docdb.cluster'),
    ent('aws_elasticache_replication_group', 'aws.elasticache.redis'),
    ent('aws_opensearch_domain', 'aws.opensearch.domain'),
    ent('aws_ssm_parameter', 'aws.ssm.parameter'),
    ent('aws_route53_zone', 'aws.route53.zone'),
    ent('aws_route53_record', 'aws.route53.record'),
    // helpers that only exist to wire things together: not drawn, not "unmapped"
    ignore('aws_db_subnet_group'),
    ignore('aws_docdb_subnet_group'),
    ignore('aws_elasticache_subnet_group'),
    ignore('aws_iam_instance_profile'),
    ignore('aws_iam_role_policy_attachment'),
    ignore('aws_eip'),
  ],
};

const gitopsManifest = {
  repoId: 'gitops',
  rules: [
    ent('helm_release', 'k8s.release.service', {}, '^orders'),
    ent('helm_release', 'k8s.release.batch', {}, '^report'),
  ],
};
const gitopsFiles = [{
  filePath: 'releases.tf',
  content: `
resource "helm_release" "orders_api" {
  name      = "orders-api"
  chart     = "orders-api"
  version   = "1.8.2"
  namespace = "orders"
}

resource "helm_release" "report_job" {
  count     = var.enable_docdb ? 1 : 0
  name      = "report-job"
  chart     = "batch-job"
  version   = "0.4.0"
  namespace = "reports"
}
`,
}];

for (const m of [platformManifest, gitopsManifest]) {
  const errors = validateManifest(m);
  if (errors.length) throw new Error(`invalid manifest ${m.repoId}: ${errors.join('; ')}`);
}

/**
 * The DOT a `terraform graph` would give for one environment: one node per
 * instantiated resource, an edge per reference between resources. A resource
 * whose `count` resolves to 0 under the environment's tfvars is not
 * instantiated, so it (and its edges) simply is not there.
 */
function dotFromTerraform(files, vars) {
  const all = [];
  for (const f of files) {
    for (const b of parseHclBlocks(f.content)) {
      if (b.blockType === 'resource' && b.labels.length === 2) all.push(`${b.labels[0]}.${b.labels[1]}`);
    }
  }
  const addresses = all.filter((a) => {
    const p = parseResourceAddress(a);
    const d = extractResourceDetails(files, { blockType: 'resource', labels: [p.type, p.name] }, vars);
    return !(d?.attributes.count?.resolved && d.attributes.count.value === 0);
  });
  const known = new Set(addresses);
  const q = (a) => `"[root] ${a} (expand)"`;
  const lines = addresses.map((a) => `\t\t${q(a)} [label = "${a}", shape = "box"]`);
  for (const a of addresses) {
    for (const ref of referencesOf(a, files, vars)) if (known.has(ref)) lines.push(`\t\t${q(a)} -> ${q(ref)}`);
  }
  return `digraph {\n\tsubgraph "root" {\n${lines.join('\n')}\n\t}\n}\n`;
}

// runtime relationships between workloads and what they talk to (not visible as Terraform references)
const LINKS = [
  { fromKind: 'k8s.release.service', toKind: 'aws.iam.role.irsa', label: 'assumes (IRSA)' },
  { fromKind: 'k8s.release.service', toKind: 'aws.rds.instance', label: 'SQL' },
  { fromKind: 'k8s.release.service', toKind: 'aws.elasticache.redis', label: 'cache' },
  { fromKind: 'k8s.release.service', toKind: 'aws.opensearch.domain', label: 'logs' },
  { fromKind: 'k8s.release.batch', toKind: 'aws.docdb.cluster', label: 'writes' },
];

const EDGE_LABELS = [
  { fromKind: 'aws.eks.cluster', toKind: 'aws.iam.role.cluster', label: 'assumes' },
  { fromKind: 'aws.eks.nodegroup', toKind: 'aws.iam.role.node', label: 'assumes' },
  { fromKind: 'aws.ssm.parameter', toKind: 'aws.rds.instance', label: 'stores endpoint' },
  { fromKind: 'aws.ssm.parameter', toKind: 'aws.docdb.cluster', label: 'stores endpoint' },
  { fromKind: 'aws.ssm.parameter', toKind: 'aws.elasticache.redis', label: 'stores endpoint' },
  { fromKind: 'aws.ssm.parameter', toKind: 'aws.opensearch.domain', label: 'stores endpoint' },
  { fromKind: 'aws.route53.record', toKind: 'aws.lb', label: 'alias' },
  { fromKind: 'aws.route53.record', toKind: 'aws.ec2.instance', label: 'points to' },
  { fromKind: 'aws.rds.instance', toKind: 'aws.security_group', label: 'protected by' },
  { fromKind: 'aws.lb', toKind: 'aws.security_group', label: 'protected by' },
  { fromKind: 'aws.vpc_peering', toKind: 'aws.vpc', label: 'peers' },
];

function buildEnvironment(environment, vars) {
  const platformParsed = parseDotGraph(dotFromTerraform(platformFiles, vars));
  const gitopsParsed = parseDotGraph(dotFromTerraform(gitopsFiles, vars));
  const filesByRepo = { platform: platformFiles, gitops: gitopsFiles };
  const repoGraphs = [
    { repoId: 'platform', manifest: platformManifest, nodes: platformParsed.nodes, edges: platformParsed.edges },
    { repoId: 'gitops', manifest: gitopsManifest, nodes: gitopsParsed.nodes, edges: gitopsParsed.edges },
  ];
  const options = {
    environment,
    repoGraphs,
    catalog,
    inferPlacement: (entities) => inferPlacementFromReferences({ entities, files: filesByRepo, vars, catalog }),
    edgeLabels: EDGE_LABELS,
  };

  // A link whose endpoint kind does not exist in this environment (no DocDB in
  // dev) is simply not applicable, not an error: find which kinds exist first.
  const kinds = new Set(compileEnvironmentGraph(options).entities.map((e) => e.kind));
  const crossRepoLinks = LINKS.filter((l) => kinds.has(l.fromKind) && kinds.has(l.toKind));
  const compiled = compileEnvironmentGraph({ ...options, crossRepoLinks });

  for (const entity of compiled.entities) {
    const files = filesByRepo[entity.repoId];
    const parsed = parseResourceAddress(entity.sourceAddress);
    if (!files || !parsed) continue;
    const details = extractResourceDetails(files, { blockType: 'resource', labels: [parsed.type, parsed.name] }, vars);
    if (details) entity.details = details.attributes;
  }
  return compiled;
}

const outDir = path.join(root, 'viewer', 'data');
await fs.mkdir(outDir, { recursive: true });

// one environment per tfvars file
const envFiles = (await fs.readdir(envDir)).filter((f) => f.endsWith('.tfvars')).sort();
const order = ['dev', 'stage', 'prod'];
envFiles.sort((a, b) => (order.indexOf(a.replace('.tfvars', '')) - order.indexOf(b.replace('.tfvars', ''))));

const environments = [];
for (const file of envFiles) {
  const name = file.replace(/\.tfvars$/, '');
  const id = `platform_${name}`;
  const vars = parseTfvars(await fs.readFile(path.join(envDir, file), 'utf8'));
  const compiled = buildEnvironment(id, vars);
  await fs.writeFile(path.join(outDir, `${id}.json`), JSON.stringify(compiled, null, 2) + '\n', 'utf8');
  environments.push({ id, label: `platform / ${name}`, source: `envs/${file}` });
  const visible = compiled.entities.filter((e) => !e.embedded).length;
  console.log(`${id}: ${compiled.entities.length} entities (${visible} drawn), ${compiled.edges.length} edges, ` +
    `unresolved placements ${compiled.unresolvedPlacements.length}, unmapped ${compiled.coverage.platform.unmapped.length}`);
}

// the older hand-written demo stays selectable
environments.push({ id: 'data_dev', label: 'minimal demo (hand-written DOT)', source: 'scripts/build-sample-data.mjs' });
await fs.writeFile(path.join(outDir, 'environments.json'), JSON.stringify({ environments }, null, 2) + '\n', 'utf8');
await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
