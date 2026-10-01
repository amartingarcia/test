#!/usr/bin/env node
// Joins the synthetic Terraform graph of platform_prod with the synthetic
// Kubernetes manifests: node groups come from Terraform, workloads nest in the
// real EKS node groups/cluster, IRSA arns link to the IAM roles.
// Run after build-platform-sample.mjs (npm run build:samples runs all three).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';
import { nodeGroupsFromCloud, mergeK8sIntoCloud } from '../lib/k8s/link-cloud.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'viewer', 'data');
const srcDir = path.join(root, 'examples', 'sample-k8s');

const cloud = JSON.parse(await fs.readFile(path.join(dataDir, 'platform_prod.json'), 'utf8'));
const names = (await fs.readdir(srcDir)).filter((f) => f.endsWith('.yaml')).sort();
const { objects, errors } = loadK8sManifests(await Promise.all(names.map(async (f) => ({ path: f, content: await fs.readFile(path.join(srcDir, f), 'utf8') }))));
if (errors.length) { console.error(errors); process.exit(1); }

const { nodeGroups, warnings } = nodeGroupsFromCloud(cloud.entities);
warnings.forEach((w) => console.warn(`warning: ${w}`));

const views = [
  { id: 'k8s_prod_namespaces', view: 'namespace', label: 'platform / prod + k8s by namespace' },
  { id: 'k8s_prod_nodes', view: 'nodes', label: 'platform / prod + k8s by node pool' },
];
const registered = [];
for (const v of views) {
  const k8s = buildK8sGraph({ environment: v.id, clusterName: 'prod-cluster', objects, view: v.view, nodeGroups });
  // the GitOps repo of the Terraform sample is superseded by the manifests
  const merged = mergeK8sIntoCloud({ environment: v.id, cloud, k8s, dropRepos: ['gitops'] });
  await fs.writeFile(path.join(dataDir, `${v.id}.json`), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  registered.push({ id: v.id, label: v.label, source: 'examples/sample-platform + examples/sample-k8s' });
  console.log(`${v.id}: ${merged.entities.length} entities, ${merged.edges.length} edges, ambiguous ${merged.unresolvedPlacements.length}, findings ${merged.findings.length}`);
  merged.findings.forEach((f) => console.log(`  finding ${f.type}: ${f.message}`));
}

const envPath = path.join(dataDir, 'environments.json');
const existing = JSON.parse(await fs.readFile(envPath, 'utf8')).environments.filter((e) => !registered.some((r) => r.id === e.id));
await fs.writeFile(envPath, JSON.stringify({ environments: [...existing, ...registered] }, null, 2) + '\n', 'utf8');
