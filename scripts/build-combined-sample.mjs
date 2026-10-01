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

const readManifests = async (dir, only) => {
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.yaml') && (!only || f === only)).sort();
  const { objects, errors } = loadK8sManifests(await Promise.all(names.map(async (f) => ({ path: f, content: await fs.readFile(path.join(dir, f), 'utf8') }))));
  if (errors.length) { console.error(errors); process.exit(1); }
  return objects;
};

const TARGETS = [
  { cloud: 'platform', cloudEnv: 'platform_prod', label: 'aws / prod + k8s', group: 'platform_prod_k8s', idPrefix: 'k8s_prod', dropRepos: ['gitops'], objects: await readManifests(srcDir) },
  ...(await Promise.all(['azure', 'gcp', 'oci'].map(async (c) => ({
    cloud: c, cloudEnv: `${c}_prod`, label: `${c} / prod + k8s`, group: `${c}_prod_k8s`, idPrefix: `${c}_prod_k8s`, dropRepos: [],
    objects: await readManifests(path.join(root, 'examples', 'sample-k8s-multi'), `${c}.yaml`),
  })))),
];

const VIEWS = [{ suffix: 'namespaces', view: 'namespace', title: 'By namespace' }, { suffix: 'nodes', view: 'nodes', title: 'By node pool' }];
const registered = [];
for (const t of TARGETS) {
  const cloud = JSON.parse(await fs.readFile(path.join(dataDir, `${t.cloudEnv}.json`), 'utf8'));
  const { nodeGroups, warnings } = nodeGroupsFromCloud(cloud.entities);
  warnings.forEach((w) => console.warn(`warning [${t.cloud}]: ${w}`));
  for (const v of VIEWS) {
    const id = `${t.idPrefix}_${v.suffix}`;
    const k8s = buildK8sGraph({ environment: id, clusterName: `${t.cloud}-prod`, objects: t.objects, view: v.view, nodeGroups });
    const merged = mergeK8sIntoCloud({ environment: id, cloud, k8s, dropRepos: t.dropRepos });
    await fs.writeFile(path.join(dataDir, `${id}.json`), JSON.stringify(merged, null, 2) + '\n', 'utf8');
    registered.push({ id, label: t.label, group: t.group, view: v.title, source: 'examples (synthetic)' });
    console.log(`${id}: ${merged.entities.length} entities, ${merged.edges.length} edges, ambiguous ${merged.unresolvedPlacements.length}, findings ${merged.findings.length}`);
    merged.findings.forEach((f) => console.log(`  finding ${f.type}: ${f.message}`));
  }
}

const envPath = path.join(dataDir, 'environments.json');
const existing = JSON.parse(await fs.readFile(envPath, 'utf8')).environments.filter((e) => !registered.some((r) => r.id === e.id));
await fs.writeFile(envPath, JSON.stringify({ environments: [...existing, ...registered] }, null, 2) + '\n', 'utf8');
