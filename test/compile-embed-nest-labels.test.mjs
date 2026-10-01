import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';
import { matchEntity } from '../lib/manifest/match-entity.mjs';
import { validateManifest } from '../lib/manifest/validate-manifest.mjs';

const node = (type, name) => ({ address: `${type}.${name}`, modulePath: [], isData: false, type, name, index: null });

test('matchEntity passes `embed` through, defaulting to false', () => {
  const manifest = { repoId: 'r', rules: [
    { match: { type: 'aws_eks_addon' }, entity: { kind: 'aws.eks.addon', idFrom: 'name', embed: true } },
    { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } },
  ] };
  assert.equal(matchEntity(node('aws_eks_addon', 'coredns'), manifest).embed, true);
  assert.equal(matchEntity(node('aws_vpc', 'main'), manifest).embed, false);
});

test('validateManifest rejects a non-boolean `embed`', () => {
  const errors = validateManifest({ repoId: 'r', rules: [
    { match: { type: 'x' }, entity: { kind: 'k', idFrom: 'name', embed: 'yes' } },
  ] });
  assert.deepEqual(errors, ['rules[0].entity.embed must be a boolean']);
});

const eksManifest = { repoId: 'infra', rules: [
  { match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } },
  { match: { type: 'aws_eks_addon' }, entity: { kind: 'aws.eks.addon', idFrom: 'name', boundary: 'aws.eks.cluster', embed: true } },
] };

test('an embedded entity is flagged `embedded: true`; others carry no such key', () => {
  const out = compileEnvironmentGraph({ environment: 'e', repoGraphs: [
    { repoId: 'infra', manifest: eksManifest, nodes: [node('aws_eks_cluster', 'this'), node('aws_eks_addon', 'coredns')], edges: [] },
  ] });
  const byKind = Object.fromEntries(out.entities.map((e) => [e.kind, e]));
  assert.equal(byKind['aws.eks.addon'].embedded, true);
  assert.equal(byKind['aws.eks.addon'].parent, byKind['aws.eks.cluster'].id);
  assert.equal('embedded' in byKind['aws.eks.cluster'], false);
});

const mk = (repoId, rules, nodes) => ({ repoId, manifest: { repoId, rules }, nodes, edges: [] });

test('a `nest` cross-repo link sets parent for every `from` entity when exactly one `to` exists; no edge is drawn', () => {
  const out = compileEnvironmentGraph({
    environment: 'e',
    repoGraphs: [
      mk('infra', [{ match: { type: 'aws_eks_node_group' }, entity: { kind: 'aws.eks.nodegroup', idFrom: 'name' } }], [node('aws_eks_node_group', 'a')]),
      mk('gitops', [{ match: { type: 'kubernetes_deployment' }, entity: { kind: 'k8s.deployment', idFrom: 'name' } }],
        [node('kubernetes_deployment', 'api'), node('kubernetes_deployment', 'worker')]),
    ],
    crossRepoLinks: [{ fromKind: 'k8s.deployment', toKind: 'aws.eks.nodegroup', nest: true }],
  });
  const ng = out.entities.find((e) => e.kind === 'aws.eks.nodegroup');
  const deps = out.entities.filter((e) => e.kind === 'k8s.deployment');
  assert.equal(deps.length, 2);
  for (const d of deps) assert.equal(d.parent, ng.id);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.unresolvedCrossRepoLinks, []);
});

test('a `nest` link is reported, not guessed, when the target is ambiguous or missing', () => {
  const out = compileEnvironmentGraph({
    environment: 'e',
    repoGraphs: [
      mk('infra', [{ match: { type: 'aws_eks_node_group' }, entity: { kind: 'aws.eks.nodegroup', idFrom: 'name' } }],
        [node('aws_eks_node_group', 'a'), node('aws_eks_node_group', 'b')]),
      mk('gitops', [{ match: { type: 'kubernetes_deployment' }, entity: { kind: 'k8s.deployment', idFrom: 'name' } }], [node('kubernetes_deployment', 'api')]),
    ],
    crossRepoLinks: [{ fromKind: 'k8s.deployment', toKind: 'aws.eks.nodegroup', nest: true }],
  });
  assert.equal(out.entities.find((e) => e.kind === 'k8s.deployment').parent, null);
  assert.deepEqual(out.unresolvedCrossRepoLinks, [{ fromKind: 'k8s.deployment', toKind: 'aws.eks.nodegroup', fromCount: 1, toCount: 2 }]);
});

test('a `nest` link never overrides an entity that already has a parent', () => {
  const out = compileEnvironmentGraph({
    environment: 'e',
    repoGraphs: [
      mk('infra', [
        { match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } },
        { match: { type: 'aws_eks_node_group' }, entity: { kind: 'aws.eks.nodegroup', idFrom: 'name', boundary: 'aws.eks.cluster' } },
      ], [node('aws_eks_cluster', 'this'), node('aws_eks_node_group', 'a')]),
      mk('net', [{ match: { type: 'aws_subnet' }, entity: { kind: 'aws.subnet', idFrom: 'name' } }], [node('aws_subnet', 's')]),
    ],
    crossRepoLinks: [{ fromKind: 'aws.eks.nodegroup', toKind: 'aws.subnet', nest: true }],
  });
  const ng = out.entities.find((e) => e.kind === 'aws.eks.nodegroup');
  assert.match(ng.parent, /aws\.eks\.cluster/);
  assert.equal(out.unresolvedCrossRepoLinks.length, 1);
  assert.equal(out.unresolvedCrossRepoLinks[0].reason, 'already-nested');
});

test('edgeLabels label unlabeled edges by their endpoint kinds, leaving others alone', () => {
  const out = compileEnvironmentGraph({
    environment: 'e',
    repoGraphs: [{
      repoId: 'infra',
      manifest: { repoId: 'infra', rules: [
        { match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } },
        { match: { type: 'aws_iam_role' }, entity: { kind: 'aws.iam.role', idFrom: 'name' } },
        { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } },
      ] },
      nodes: [node('aws_eks_cluster', 'this'), node('aws_iam_role', 'r'), node('aws_vpc', 'v')],
      edges: [{ from: 'aws_eks_cluster.this', to: 'aws_iam_role.r' }, { from: 'aws_eks_cluster.this', to: 'aws_vpc.v' }],
    }],
    edgeLabels: [{ fromKind: 'aws.eks.cluster', toKind: 'aws.iam.role', label: 'assumes' }],
  });
  assert.equal(out.edges.find((e) => e.to.includes('iam')).label, 'assumes');
  assert.equal('label' in out.edges.find((e) => e.to.includes('vpc')), false);
});
