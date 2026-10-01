import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeGroupsFromCloud, mergeK8sIntoCloud } from '../lib/k8s/link-cloud.mjs';
import { candidatePools } from '../lib/k8s/scheduling.mjs';
import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';

const v = (value) => ({ resolved: true, value });
const raw = (r) => ({ resolved: false, raw: r });
const cloud = {
  environment: 'prod',
  entities: [
    { id: 'p:aws.eks.cluster:this', kind: 'aws.eks.cluster', parent: null, repoId: 'p', details: { name: v('prod-cluster') } },
    { id: 'p:aws.eks.nodegroup:system', kind: 'aws.eks.nodegroup', parent: 'p:aws.eks.cluster:this', repoId: 'p', details: { node_group_name: v('system'), labels: v({ 'node-role': 'system' }), 'taint.key': v('CriticalAddonsOnly'), 'taint.effect': v('NO_SCHEDULE') } },
    { id: 'p:aws.eks.nodegroup:odd', kind: 'aws.eks.nodegroup', parent: 'p:aws.eks.cluster:this', repoId: 'p', details: { node_group_name: v('odd'), labels: raw('local.labels') } },
    { id: 'p:aws.iam.role.workload:wl_web', kind: 'aws.iam.role.workload', parent: null, repoId: 'p', details: { name: v('shop-prod-web') } },
    { id: 'g:k8s.release.service:x', kind: 'k8s.release.service', parent: null, repoId: 'gitops', details: {} },
  ],
  edges: [{ from: 'g:k8s.release.service:x', to: 'p:aws.eks.cluster:this' }],
  coverage: { p: { unmapped: [], unresolvedBoundaries: [] } },
  unresolvedCrossRepoLinks: [],
  unresolvedPlacements: [{ entityId: 'g:k8s.release.service:x', parentKind: 'aws.eks.nodegroup', candidateCount: 2 }],
};

test('node groups are derived from the cloud graph; unresolved labels are flagged uncertain, taints mapped to k8s effects', () => {
  const { nodeGroups } = nodeGroupsFromCloud(cloud.entities);
  const sys = nodeGroups.find((g) => g.name === 'system');
  assert.deepEqual(sys.labels, { 'node-role': 'system' });
  assert.deepEqual(sys.taints, [{ key: 'CriticalAddonsOnly', value: undefined, effect: 'NoSchedule' }]);
  assert.equal(nodeGroups.find((g) => g.name === 'odd').uncertain, true);
});

test('an uncertain pool never lets a placement be called resolved or impossible', () => {
  const pools = [{ name: 'a', labels: { x: '1' }, requirements: [], taints: [] }, { name: 'u', labels: {}, requirements: [], taints: [], uncertain: true }];
  assert.equal(candidatePools({ nodeSelector: { x: '1' } }, pools).status, 'ambiguous');
  assert.equal(candidatePools({ nodeSelector: { y: '1' } }, [{ name: 'u', labels: {}, requirements: [], taints: [], uncertain: true }]).status, 'unknown');
});

const k8sYaml = `
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop}
spec:
  template:
    metadata: {labels: {a: w}}
    spec: {serviceAccountName: web, nodeSelector: {node-role: system}, tolerations: [{key: CriticalAddonsOnly, operator: Exists}], containers: [{name: c, image: i}]}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web
  namespace: shop
  annotations: {eks.amazonaws.com/role-arn: "arn:aws:iam::111111111111:role/service-role/shop-prod-web"}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: lost, namespace: shop}
spec:
  template:
    metadata: {labels: {a: l}}
    spec: {serviceAccountName: lost, containers: [{name: c, image: i}]}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: lost
  namespace: shop
  annotations: {eks.amazonaws.com/role-arn: "arn:aws:iam::111111111111:role/nope"}
`;

function merged(view, cl = cloud) {
  const { objects } = loadK8sManifests([{ path: 'k.yaml', content: k8sYaml }]);
  const { nodeGroups } = nodeGroupsFromCloud(cl.entities);
  const k8s = buildK8sGraph({ environment: 'k', clusterName: 'prod-cluster', objects, view, nodeGroups });
  return mergeK8sIntoCloud({ environment: 'prod_k8s', cloud: cl, k8s, dropRepos: ['gitops'] });
}
const withoutOdd = { ...cloud, entities: cloud.entities.filter((e) => !e.id.endsWith(':odd')) };
const ent = (g, id) => g.entities.find((e) => e.id === id);

test('nodes view: workloads nest in the real AWS node group, k8s duplicates of cluster/nodegroup disappear', () => {
  const g = merged('nodes', withoutOdd);
  assert.equal(ent(g, 'k8s:k8s.deployment:shop/web').parent, 'p:aws.eks.nodegroup:system');
  assert.equal(g.entities.some((e) => e.kind === 'k8s.cluster' || e.kind === 'k8s.nodegroup'), false);
});

test('namespace view: namespaces live inside the AWS EKS cluster', () => {
  const g = merged('namespace');
  assert.equal(ent(g, 'k8s:k8s.namespace:shop').parent, 'p:aws.eks.cluster:this');
});

test('IRSA: workload -> IAM role by role name; a role missing from the cloud graph is a finding', () => {
  const g = merged('namespace');
  assert.ok(g.edges.some((e) => e.from === 'k8s:k8s.deployment:shop/web' && e.to === 'p:aws.iam.role.workload:wl_web' && e.label === 'assumes (IRSA)'));
  assert.ok(g.findings.some((f) => f.type === 'irsa-role-not-found' && f.entityId === 'k8s:k8s.deployment:shop/lost'));
});

test('dropped repos disappear with their edges and ambiguity reports; the rest of the cloud graph is intact', () => {
  const g = merged('namespace');
  assert.equal(g.entities.some((e) => e.repoId === 'gitops'), false);
  assert.equal(g.edges.some((e) => e.from.startsWith('g:')), false);
  assert.deepEqual(g.unresolvedPlacements, []);
  assert.equal(g.environment, 'prod_k8s');
  assert.ok(ent(g, 'p:aws.eks.cluster:this'));
});

test('refuses to guess when the cloud graph has no single EKS cluster', () => {
  const { objects } = loadK8sManifests([{ path: 'k.yaml', content: k8sYaml }]);
  const k8s = buildK8sGraph({ environment: 'k', clusterName: 'c', objects, view: 'namespace' });
  const two = { ...cloud, entities: [...cloud.entities, { id: 'p:aws.eks.cluster:other', kind: 'aws.eks.cluster', parent: null, repoId: 'p', details: {} }] };
  assert.throws(() => mergeK8sIntoCloud({ environment: 'x', cloud: two, k8s }), /exactly one Kubernetes cluster/);
});

test('a node group with unresolved labels keeps affected workloads at cluster level, reported', () => {
  const g = merged('nodes');
  assert.equal(ent(g, 'k8s:k8s.deployment:shop/web').parent, 'p:aws.eks.cluster:this');
  assert.ok(g.unresolvedPlacements.some((u) => u.entityId === 'k8s:k8s.deployment:shop/web' && u.reason === 'ambiguous'));
});
