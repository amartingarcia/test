import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeGroupsFromCloud, mergeK8sIntoCloud } from '../lib/k8s/link-cloud.mjs';
import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';

const v = (value) => ({ resolved: true, value });
const raw = (r) => ({ resolved: false, raw: r });
const E = (id, kind, details, parent = null) => ({ id, kind, parent, repoId: 'c', details });

test('AKS: user pools (labels, taints in key=value:Effect form) and the default pool declared inside the cluster', () => {
  const { nodeGroups } = nodeGroupsFromCloud([
    E('c:azure.aks.cluster:main', 'azure.aks.cluster', { 'default_node_pool.name': v('system'), 'default_node_pool.only_critical_addons_enabled': v(true) }),
    E('c:azure.aks.nodepool:batch', 'azure.aks.nodepool', { name: v('batch'), node_labels: v({ workload: 'batch' }), node_taints: v(['batch=true:NoSchedule']) }),
  ]);
  const batch = nodeGroups.find((g) => g.name === 'batch');
  assert.deepEqual(batch.labels, { workload: 'batch', 'kubernetes.azure.com/agentpool': 'batch', 'kubernetes.azure.com/mode': 'user' });
  assert.deepEqual(batch.taints, [{ key: 'batch', value: 'true', effect: 'NoSchedule' }]);
  assert.deepEqual(batch.source, { entityId: 'c:azure.aks.nodepool:batch' });
  const sys = nodeGroups.find((g) => g.name === 'system');
  assert.deepEqual(sys.taints, [{ key: 'CriticalAddonsOnly', value: 'true', effect: 'NoSchedule' }]);
  assert.deepEqual(sys.source, { clusterId: 'c:azure.aks.cluster:main' });
});

test('AKS: a taint that is not key=value:Effect makes the pool uncertain', () => {
  const { nodeGroups, warnings } = nodeGroupsFromCloud([E('c:azure.aks.nodepool:x', 'azure.aks.nodepool', { name: v('x'), node_taints: v(['weird']) })]);
  assert.equal(nodeGroups[0].uncertain, true);
  assert.equal(warnings.length, 1);
});

test('GKE: node_config labels/taints/spot plus the implicit nodepool label', () => {
  const { nodeGroups } = nodeGroupsFromCloud([E('c:gcp.gke.nodepool:spot', 'gcp.gke.nodepool', {
    name: v('spot'), 'node_config.spot': v(true), 'node_config.labels': v({ workload: 'batch' }),
    'node_config.taint.key': v('batch'), 'node_config.taint.value': v('true'), 'node_config.taint.effect': v('NO_SCHEDULE'),
  })]);
  assert.deepEqual(nodeGroups[0].labels, { workload: 'batch', 'cloud.google.com/gke-spot': 'true', 'cloud.google.com/gke-nodepool': 'spot' });
  assert.deepEqual(nodeGroups[0].taints, [{ key: 'batch', value: 'true', effect: 'NoSchedule' }]);
});

test('OKE: initial_node_labels blocks become labels; unresolved ones make the pool uncertain', () => {
  const ok = nodeGroupsFromCloud([E('c:oci.oke.nodepool:g', 'oci.oke.nodepool', { name: v('g'), 'initial_node_labels.key': v('workload'), 'initial_node_labels.value': v('general') })]);
  assert.deepEqual(ok.nodeGroups[0].labels, { workload: 'general' });
  const bad = nodeGroupsFromCloud([E('c:oci.oke.nodepool:g', 'oci.oke.nodepool', { name: v('g'), 'initial_node_labels.key': v('workload'), 'initial_node_labels.value': raw('var.x') })]);
  assert.equal(bad.nodeGroups[0].uncertain, true);
});

const YAML = `
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop}
spec:
  template:
    metadata: {labels: {a: w}}
    spec: {serviceAccountName: web, nodeSelector: {workload: general}, containers: [{name: c, image: i}]}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web
  namespace: shop
  annotations: {iam.gke.io/gcp-service-account: "app-workload@sample-project.iam.gserviceaccount.com"}
`;
const merge = (cloud, view = 'nodes') => {
  const { objects } = loadK8sManifests([{ path: 'k.yaml', content: YAML }]);
  const { nodeGroups } = nodeGroupsFromCloud(cloud.entities);
  const k8s = buildK8sGraph({ environment: 'k', clusterName: 'c', objects, view, nodeGroups });
  return mergeK8sIntoCloud({ environment: 'm', cloud, k8s });
};
const base = { environment: 'x', edges: [], coverage: {}, unresolvedPlacements: [] };

test('GKE merge: workloads nest in the real node pool; workload identity links to the Google service account', () => {
  const cloud = { ...base, entities: [
    E('c:gcp.gke.cluster:gke', 'gcp.gke.cluster', {}),
    E('c:gcp.gke.nodepool:general', 'gcp.gke.nodepool', { name: v('general'), 'node_config.labels': v({ workload: 'general' }) }, 'c:gcp.gke.cluster:gke'),
    E('c:gcp.service_account:workload', 'gcp.service_account', { account_id: v('app-workload') }),
  ] };
  const nodes = merge(cloud, 'nodes');
  assert.equal(nodes.entities.find((e) => e.id === 'k8s:k8s.deployment:shop/web').parent, 'c:gcp.gke.nodepool:general');
  assert.ok(nodes.edges.some((e) => e.from === 'k8s:k8s.deployment:shop/web' && e.to === 'c:gcp.service_account:workload'));
  const missing = merge({ ...cloud, entities: cloud.entities.slice(0, 2) }, 'nodes');
  assert.ok(missing.findings.some((f) => f.type === 'gsa-not-found'));
});

test('AKS merge: the default pool stays drawn inside the cluster, without a "not in cloud" finding', () => {
  const cloud = { ...base, entities: [E('c:azure.aks.cluster:main', 'azure.aks.cluster', { 'default_node_pool.name': v('workload'), 'default_node_pool.node_labels': v({ workload: 'general' }) })] };
  const g = merge(cloud, 'nodes');
  const pool = g.entities.find((e) => e.id === 'k8s:k8s.nodegroup:workload');
  assert.equal(pool.parent, 'c:azure.aks.cluster:main');
  assert.equal(g.entities.find((e) => e.id === 'k8s:k8s.deployment:shop/web').parent, 'k8s:k8s.nodegroup:workload');
  assert.equal(g.findings.some((f) => f.type === 'nodegroup-not-in-cloud'), false);
});
