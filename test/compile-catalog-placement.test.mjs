import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';
import { specForKind } from '../lib/catalog/spec-for-kind.mjs';

const node = (type, name) => ({ address: `${type}.${name}`, modulePath: [], isData: false, type, name, index: null });
const repo = (repoId, rules, nodes) => ({ repoId, manifest: { repoId, rules }, nodes, edges: [] });
const rule = (type, kind, extra = {}) => ({ match: { type }, entity: { kind, idFrom: 'name', ...extra } });

const catalog = { kinds: {
  'aws.rds.instance': { placement: { parentKinds: ['aws.subnet.data', 'aws.vpc'] } },
  'aws.eks.cluster': { placement: { parentKinds: ['aws.subnet.private'] } },
} };

test('specForKind falls back from the exact kind to its longest known prefix', () => {
  const kinds = { 'aws.iam': { group: 'iam' }, 'aws.iam.role.irsa': { order: 3 } };
  assert.deepEqual(specForKind(kinds, 'aws.iam.role.irsa'), { order: 3 });
  assert.deepEqual(specForKind(kinds, 'aws.iam.role.node'), { group: 'iam' });
  assert.deepEqual(specForKind(kinds, 'gcp.thing'), {});
});

test('the catalog places an unparented entity in the unique candidate of its first parent kind', () => {
  const out = compileEnvironmentGraph({
    environment: 'e', catalog,
    repoGraphs: [
      repo('net', [rule('aws_vpc', 'aws.vpc'), rule('aws_subnet', 'aws.subnet.data')], [node('aws_vpc', 'v'), node('aws_subnet', 'd')]),
      repo('infra', [rule('aws_db_instance', 'aws.rds.instance')], [node('aws_db_instance', 'orders')]),
    ],
  });
  const rds = out.entities.find((e) => e.kind === 'aws.rds.instance');
  assert.equal(rds.parent, 'net:aws.subnet.data:d'); // data subnet wins over the VPC fallback
  assert.deepEqual(out.unresolvedPlacements, []);
});

test('it falls back to the next parent kind when the first has no candidate', () => {
  const out = compileEnvironmentGraph({
    environment: 'e', catalog,
    repoGraphs: [
      repo('net', [rule('aws_vpc', 'aws.vpc')], [node('aws_vpc', 'v')]),
      repo('infra', [rule('aws_db_instance', 'aws.rds.instance')], [node('aws_db_instance', 'orders')]),
    ],
  });
  assert.equal(out.entities.find((e) => e.kind === 'aws.rds.instance').parent, 'net:aws.vpc:v');
});

test('several candidates of the chosen parent kind are reported, never guessed', () => {
  const out = compileEnvironmentGraph({
    environment: 'e', catalog,
    repoGraphs: [
      repo('net', [rule('aws_subnet', 'aws.subnet.private')], [node('aws_subnet', 'a'), node('aws_subnet', 'b')]),
      repo('infra', [rule('aws_eks_cluster', 'aws.eks.cluster')], [node('aws_eks_cluster', 'this')]),
    ],
  });
  assert.equal(out.entities.find((e) => e.kind === 'aws.eks.cluster').parent, null);
  assert.deepEqual(out.unresolvedPlacements, [
    { entityId: 'infra:aws.eks.cluster:this', parentKind: 'aws.subnet.private', candidateCount: 2 },
  ]);
});

test('an existing parent (boundary or nest link) is never overridden by the catalog', () => {
  const out = compileEnvironmentGraph({
    environment: 'e', catalog,
    repoGraphs: [
      repo('net', [rule('aws_vpc', 'aws.vpc'), rule('aws_subnet', 'aws.subnet.data')], [node('aws_vpc', 'v'), node('aws_subnet', 'd')]),
      repo('infra', [rule('aws_db_instance', 'aws.rds.instance', { boundary: 'aws.thing' })], [node('aws_db_instance', 'orders')]),
    ],
    crossRepoLinks: [{ fromKind: 'aws.rds.instance', toKind: 'aws.vpc', nest: true }],
  });
  assert.equal(out.entities.find((e) => e.kind === 'aws.rds.instance').parent, 'net:aws.vpc:v');
});

test('without a catalog nothing changes and unresolvedPlacements is empty', () => {
  const out = compileEnvironmentGraph({
    environment: 'e',
    repoGraphs: [repo('infra', [rule('aws_db_instance', 'aws.rds.instance')], [node('aws_db_instance', 'orders')])],
  });
  assert.equal(out.entities[0].parent, null);
  assert.deepEqual(out.unresolvedPlacements, []);
});

test('ignored nodes are neither entities nor reported as unmapped, and their edges are dropped', () => {
  const out = compileEnvironmentGraph({ environment: 'e', repoGraphs: [{
    repoId: 'r',
    manifest: { repoId: 'r', rules: [
      { match: { type: 'aws_db_subnet_group' }, ignore: true },
      { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } },
    ] },
    nodes: [node('aws_db_subnet_group', 'g'), node('aws_vpc', 'v'), node('aws_other', 'x')],
    edges: [{ from: 'aws_db_subnet_group.g', to: 'aws_vpc.v' }],
  }] });
  assert.deepEqual(out.entities.map((e) => e.kind), ['aws.vpc']);
  assert.deepEqual(out.coverage.r.unmapped, ['aws_other.x']); // only the genuinely unmapped one
  assert.deepEqual(out.edges, []);
});

test('the inferPlacement hook runs before the catalog: its placements win, its ambiguities block the catalog fallback', () => {
  const cat = { kinds: { 'aws.rds.instance': { placement: { parentKinds: ['aws.vpc'] } }, 'aws.ec2.instance': { placement: { parentKinds: ['aws.vpc'] } } } };
  const rules = [
    { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } },
    { match: { type: 'aws_db_instance' }, entity: { kind: 'aws.rds.instance', idFrom: 'name' } },
    { match: { type: 'aws_instance' }, entity: { kind: 'aws.ec2.instance', idFrom: 'name' } },
  ];
  const out = compileEnvironmentGraph({
    environment: 'e', catalog: cat,
    repoGraphs: [{ repoId: 'r', manifest: { repoId: 'r', rules }, edges: [],
      nodes: [node('aws_vpc', 'a'), node('aws_db_instance', 'db'), node('aws_instance', 'vm')] }],
    inferPlacement: (entities) => ({
      placements: [{ entityId: 'r:aws.rds.instance:db', parent: 'r:aws.vpc:a' }],
      unresolved: [{ entityId: 'r:aws.ec2.instance:vm', parentKind: 'aws.vpc', candidateCount: 2 }],
    }),
  });
  assert.equal(out.entities.find((e) => e.kind === 'aws.rds.instance').parent, 'r:aws.vpc:a');
  assert.equal(out.entities.find((e) => e.kind === 'aws.ec2.instance').parent, null);
  assert.deepEqual(out.unresolvedPlacements, [{ entityId: 'r:aws.ec2.instance:vm', parentKind: 'aws.vpc', candidateCount: 2 }]);
});
