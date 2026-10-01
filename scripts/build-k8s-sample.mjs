#!/usr/bin/env node
// Builds the two Kubernetes views (by namespace / by node pool) of the synthetic
// sample cluster in examples/sample-k8s/ into viewer/data/.
//
//   node scripts/build-k8s-sample.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../lib/catalog/load-catalog.mjs';
import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'examples', 'sample-k8s');
const outDir = path.join(root, 'viewer', 'data');

const names = (await fs.readdir(srcDir)).filter((f) => f.endsWith('.yaml')).sort();
const files = await Promise.all(names.map(async (f) => ({ path: f, content: await fs.readFile(path.join(srcDir, f), 'utf8') })));
const { objects, errors } = loadK8sManifests(files);
if (errors.length) { console.error(errors); process.exit(1); }

// In a real run these come from the cloud layer (the EKS managed node groups of the Terraform graph).
const nodeGroups = [{ name: 'system', labels: { 'node-role': 'system' }, taints: [{ key: 'CriticalAddonsOnly', effect: 'NoSchedule' }] }];

const views = [
  { id: 'k8s_namespaces', view: 'namespace', label: 'k8s sample (Karpenter + ArgoCD)', title: 'By namespace' },
  { id: 'k8s_nodes', view: 'nodes', label: 'k8s sample (Karpenter + ArgoCD)', title: 'By node pool' },
];
const environments = [];
for (const v of views) {
  const graph = buildK8sGraph({ environment: v.id, clusterName: 'shop-prod', objects, view: v.view, nodeGroups });
  await fs.writeFile(path.join(outDir, `${v.id}.json`), JSON.stringify(graph, null, 2) + '\n', 'utf8');
  environments.push({ id: v.id, label: v.label, group: 'k8s_sample', view: v.title, source: 'examples/sample-k8s' });
  console.log(`${v.id}: ${graph.entities.length} entities, ${graph.edges.length} edges, unmapped ${graph.coverage.k8s.unmapped.length}, ` +
    `ambiguous placements ${graph.unresolvedPlacements.length}, findings ${graph.findings.length}`);
}

const envPath = path.join(outDir, 'environments.json');
const existing = JSON.parse(await fs.readFile(envPath, 'utf8')).environments.filter((e) => !views.some((v) => v.id === e.id));
await fs.writeFile(envPath, JSON.stringify({ environments: [...existing, ...environments] }, null, 2) + '\n', 'utf8');
await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify(await loadCatalog(path.join(root, 'catalog', 'providers')), null, 2) + '\n', 'utf8');
