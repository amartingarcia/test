import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYamlDocuments } from '../lib/yaml/parse-yaml.mjs';
import { candidatePools } from '../lib/k8s/scheduling.mjs';
import { nodeGroupsFromCloud } from '../lib/k8s/link-cloud.mjs';
import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';
import { inferPlacementFromReferences } from '../lib/compile/infer-placement.mjs';

/* ---- YAML: block scalar as sequence item ---- */
test('yaml: block scalars are valid sequence items', () => {
  const [doc] = parseYamlDocuments('args:\n  - |\n    echo hi\n    echo there\n  - >-\n    folded\n    text\n  - plain\n');
  assert.deepEqual(doc.args, ['echo hi\necho there\n', 'folded text', 'plain']);
});

/* ---- scheduling: operators we cannot decide must not exclude a pool ---- */
const pool = (name, extra = {}) => ({ name, labels: {}, requirements: [], taints: [], ...extra });

test('scheduling: Gt/Lt/NotIn requirement on a selected key is undecidable, not a mismatch', () => {
  const gt = pool('gt', { requirements: [{ key: 'karpenter.k8s.aws/instance-cpu', operator: 'Gt', values: ['4'] }] });
  const r = candidatePools({ nodeSelector: { 'karpenter.k8s.aws/instance-cpu': '8' } }, [gt]);
  assert.notEqual(r.status, 'none');
  assert.equal(r.status, 'unknown');
  const notin = pool('notin', { requirements: [{ key: 'node.kubernetes.io/instance-type', operator: 'NotIn', values: ['m5.large'] }] });
  assert.notEqual(candidatePools({ nodeSelector: { 'node.kubernetes.io/instance-type': 'c5.large' } }, [notin]).status, 'none');
});

test('scheduling: several requirements on one key are all evaluated', () => {
  const p = pool('multi', { requirements: [
    { key: 'topology.kubernetes.io/zone', operator: 'In', values: ['a', 'b'] },
    { key: 'topology.kubernetes.io/zone', operator: 'In', values: ['b', 'c'] },
  ] });
  assert.equal(candidatePools({ nodeSelector: { 'topology.kubernetes.io/zone': 'b' } }, [p]).status, 'resolved');
  assert.equal(candidatePools({ nodeSelector: { 'topology.kubernetes.io/zone': 'a' } }, [p]).status, 'none');
});

test('scheduling: DoesNotExist on a well-known label never matches (nodes always carry it)', () => {
  const affinity = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/arch', operator: 'DoesNotExist' }] }] } } };
  assert.equal(candidatePools({ affinity }, [pool('p')]).status, 'none');
});

/* ---- Argo: no false "deploys to" for another cluster ---- */
const buildYaml = (yaml) => {
  const { objects, errors } = loadK8sManifests([{ path: 't.yaml', content: yaml }]);
  assert.deepEqual(errors, []);
  return buildK8sGraph({ environment: 'k8s_t', clusterName: 'c1', objects, view: 'namespace' });
};
const app = (dest) => `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: a1, namespace: argocd}
spec:
  source: {repoURL: 'https://example.com/r.git', path: x, targetRevision: main}
  destination: ${dest}
`;

test('argo: destination on another cluster draws no edge and no namespace', () => {
  const g = buildYaml(app('{server: "https://other.example.com", namespace: remote-ns}'));
  assert.equal(g.edges.some((e) => e.label === 'deploys to'), false);
  assert.equal(g.entities.some((e) => e.id === 'k8s:k8s.namespace:remote-ns'), false);
});

test('argo: in-cluster destination keeps the edge', () => {
  const g = buildYaml(app('{server: "https://kubernetes.default.svc", namespace: shop}'));
  assert.ok(g.edges.some((e) => e.label === 'deploys to' && e.to === 'k8s:k8s.namespace:shop'));
});

/* ---- link-cloud: honesty of node pool facts ---- */
const R = (value) => ({ resolved: true, value });
const U = (raw) => ({ resolved: false, raw });
const ng = (kind, details, id = `p:${kind}:x`) => nodeGroupsFromCloud([{ id, kind, details }]);

test('link-cloud: dynamic taint blocks and attribute-form taints make the pool uncertain', () => {
  const eks = ng('aws.eks.nodegroup', { node_group_name: R('n'), 'dynamic.taint.content.key': U('taint.value.key') });
  assert.equal(eks.nodeGroups[0].uncertain, true);
  const gke = ng('gcp.gke.nodepool', { name: R('n'), 'node_config.taint': U('local.taints') });
  assert.equal(gke.nodeGroups[0].uncertain, true);
});

test('link-cloud: an unresolved pool name is not replaced by the Terraform label', () => {
  const r = ng('azure.aks.nodepool', { name: U('each.key') }, 'p:azure.aks.nodepool:pools');
  assert.equal(r.nodeGroups[0].uncertain, true);
  assert.equal(r.nodeGroups[0].labels['kubernetes.azure.com/agentpool'], undefined);
});

test('link-cloud: AKS Spot pools carry the documented scalesetpriority label and taint; mode label from `mode`', () => {
  const r = ng('azure.aks.nodepool', { name: R('batch'), priority: R('Spot'), mode: R('User') });
  const g = r.nodeGroups[0];
  assert.equal(g.labels['kubernetes.azure.com/scalesetpriority'], 'spot');
  assert.ok(g.taints.some((t) => t.key === 'kubernetes.azure.com/scalesetpriority' && t.value === 'spot' && t.effect === 'NoSchedule'));
  assert.equal(g.labels['kubernetes.azure.com/mode'], 'user');
  // not duplicated when the user also declares it
  const dup = ng('azure.aks.nodepool', { name: R('batch'), priority: R('Spot'), node_taints: R(['kubernetes.azure.com/scalesetpriority=spot:NoSchedule']) });
  assert.equal(dup.nodeGroups[0].taints.filter((t) => t.key === 'kubernetes.azure.com/scalesetpriority').length, 1);
});

test('link-cloud: unresolved Spot priority makes an AKS pool uncertain', () => {
  assert.equal(ng('azure.aks.nodepool', { name: R('b'), priority: U('var.p') }).nodeGroups[0].uncertain, true);
});

test('link-cloud: EKS capacityType label comes from capacity_type; unresolved is uncertain', () => {
  assert.equal(ng('aws.eks.nodegroup', { node_group_name: R('n'), capacity_type: R('SPOT') }).nodeGroups[0].labels['eks.amazonaws.com/capacityType'], 'SPOT');
  assert.equal(ng('aws.eks.nodegroup', { node_group_name: R('n') }).nodeGroups[0].labels['eks.amazonaws.com/capacityType'], 'ON_DEMAND');
  assert.equal(ng('aws.eks.nodegroup', { node_group_name: R('n'), capacity_type: U('var.c') }).nodeGroups[0].uncertain, true);
});

/* ---- placement: several subnets of one VPC -> the VPC ---- */
test('placement: a resource spanning several subnets of the same VPC is placed in that VPC', () => {
  const catalog = { kinds: { 'aws.eks.cluster': { placement: { parentKinds: ['aws.subnet', 'aws.vpc'] } } } };
  const ent = (kind, address) => ({ id: `r:${kind}:${address}`, kind, repoId: 'r', sourceAddress: address, parent: null });
  const entities = [ent('aws.vpc', 'aws_vpc.main'), ent('aws.subnet', 'aws_subnet.a'), ent('aws.subnet', 'aws_subnet.b'), ent('aws.eks.cluster', 'aws_eks_cluster.c')];
  const files = { r: [{ filePath: 'main.tf', content: `
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "a" { vpc_id = aws_vpc.main.id }
resource "aws_subnet" "b" { vpc_id = aws_vpc.main.id }
resource "aws_eks_cluster" "c" { vpc_config { subnet_ids = [aws_subnet.a.id, aws_subnet.b.id] } }
` }] };
  const { placements, unresolved } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.deepEqual(placements.filter((p) => p.entityId.endsWith('aws_eks_cluster.c')), [{ entityId: 'r:aws.eks.cluster:aws_eks_cluster.c', parent: 'r:aws.vpc:aws_vpc.main' }]);
  assert.deepEqual(unresolved, []);
});

test('placement: subnets of different VPCs stay unresolved', () => {
  const catalog = { kinds: { 'aws.eks.cluster': { placement: { parentKinds: ['aws.subnet', 'aws.vpc'] } } } };
  const ent = (kind, address) => ({ id: `r:${kind}:${address}`, kind, repoId: 'r', sourceAddress: address, parent: null });
  const entities = [ent('aws.vpc', 'aws_vpc.x'), ent('aws.vpc', 'aws_vpc.y'), ent('aws.subnet', 'aws_subnet.a'), ent('aws.subnet', 'aws_subnet.b'), ent('aws.eks.cluster', 'aws_eks_cluster.c')];
  const files = { r: [{ filePath: 'main.tf', content: `
resource "aws_vpc" "x" { cidr_block = "10.0.0.0/16" }
resource "aws_vpc" "y" { cidr_block = "10.1.0.0/16" }
resource "aws_subnet" "a" { vpc_id = aws_vpc.x.id }
resource "aws_subnet" "b" { vpc_id = aws_vpc.y.id }
resource "aws_eks_cluster" "c" { vpc_config { subnet_ids = [aws_subnet.a.id, aws_subnet.b.id] } }
` }] };
  const { placements, unresolved } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.equal(placements.some((p) => p.entityId.endsWith('aws_eks_cluster.c')), false);
  assert.equal(unresolved.length, 1);
});
