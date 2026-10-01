import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';

const networkManifest = {
  repoId: 'network',
  rules: [
    { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } },
    { match: { type: 'aws_subnet' }, entity: { kind: 'aws.subnet', idFrom: 'address', boundary: 'aws.vpc' } },
  ],
};

const infraManifest = {
  repoId: 'infra',
  rules: [{ match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } }],
};

function networkGraph() {
  return {
    repoId: 'network',
    manifest: networkManifest,
    nodes: [
      { address: 'aws_vpc.main', modulePath: [], isData: false, type: 'aws_vpc', name: 'main', index: null },
      { address: 'aws_subnet.public', modulePath: [], isData: false, type: 'aws_subnet', name: 'public', index: null },
      { address: 'aws_flow_log.vpc', modulePath: [], isData: false, type: 'aws_flow_log', name: 'vpc', index: null }, // unmapped on purpose
    ],
    edges: [{ from: 'aws_subnet.public', to: 'aws_vpc.main' }],
  };
}

function infraGraph() {
  return {
    repoId: 'infra',
    manifest: infraManifest,
    nodes: [{ address: 'aws_eks_cluster.this', modulePath: [], isData: false, type: 'aws_eks_cluster', name: 'this', index: null }],
    edges: [],
  };
}

test('merges entities from two repos with repo-scoped unique ids', () => {
  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [networkGraph(), infraGraph()],
  });

  assert.deepEqual(
    result.entities.map((e) => e.id).sort(),
    ['infra:aws.eks.cluster:this', 'network:aws.subnet:aws_subnet.public', 'network:aws.vpc:main']
  );
});

test('translates edges to compiled entity ids and drops edges touching an unmapped node', () => {
  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [networkGraph(), infraGraph()],
  });

  assert.equal(result.edges.length, 1);
  assert.deepEqual(result.edges[0], {
    from: 'network:aws.subnet:aws_subnet.public',
    to: 'network:aws.vpc:main',
  });
});

test('reports unmapped nodes per repo instead of silently dropping them', () => {
  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [networkGraph(), infraGraph()],
  });

  assert.deepEqual(result.coverage.network.unmapped, ['aws_flow_log.vpc']);
  assert.deepEqual(result.coverage.infra.unmapped, []);
});

test('resolves boundary to the single matching entity of that kind in the same repo', () => {
  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [networkGraph(), infraGraph()],
  });

  const subnet = result.entities.find((e) => e.id === 'network:aws.subnet:aws_subnet.public');
  assert.equal(subnet.parent, 'network:aws.vpc:main');
});

test('leaves boundary unresolved (parent: null) and reports it when zero candidates exist in that repo', () => {
  const manifestWithDanglingBoundary = {
    repoId: 'infra',
    rules: [{ match: { type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name', boundary: 'aws.vpc' } }],
  };
  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [{ ...infraGraph(), manifest: manifestWithDanglingBoundary }],
  });

  const cluster = result.entities[0];
  assert.equal(cluster.parent, null);
  assert.deepEqual(result.coverage.infra.unresolvedBoundaries, [
    { entityId: 'infra:aws.eks.cluster:this', boundary: 'aws.vpc', candidateCount: 0 },
  ]);
});

test('leaves boundary unresolved and reports it when multiple candidates exist (ambiguous, never guessed)', () => {
  const ambiguousGraph = {
    repoId: 'network',
    manifest: networkManifest,
    nodes: [
      { address: 'aws_vpc.one', modulePath: [], isData: false, type: 'aws_vpc', name: 'one', index: null },
      { address: 'aws_vpc.two', modulePath: [], isData: false, type: 'aws_vpc', name: 'two', index: null },
      { address: 'aws_subnet.public', modulePath: [], isData: false, type: 'aws_subnet', name: 'public', index: null },
    ],
    edges: [],
  };

  const result = compileEnvironmentGraph({ environment: 'data_dev', repoGraphs: [ambiguousGraph] });

  const subnet = result.entities.find((e) => e.kind === 'aws.subnet');
  assert.equal(subnet.parent, null);
  assert.deepEqual(result.coverage.network.unresolvedBoundaries, [
    { entityId: 'network:aws.subnet:aws_subnet.public', boundary: 'aws.vpc', candidateCount: 2 },
  ]);
});

test('cross-repo links: wires a 1:1 kind pair across repos when exactly one of each exists', () => {
  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [networkGraph(), infraGraph()],
    crossRepoLinks: [{ fromKind: 'aws.eks.cluster', toKind: 'aws.vpc', label: 'runs in' }],
  });

  const crossEdge = result.edges.find((e) => e.from === 'infra:aws.eks.cluster:this');
  assert.deepEqual(crossEdge, {
    from: 'infra:aws.eks.cluster:this',
    to: 'network:aws.vpc:main',
    label: 'runs in',
  });
});

test('cross-repo links: reports rather than guesses when either side is not exactly one entity', () => {
  const ambiguousGraph = {
    repoId: 'network',
    manifest: networkManifest,
    nodes: [
      { address: 'aws_vpc.one', modulePath: [], isData: false, type: 'aws_vpc', name: 'one', index: null },
      { address: 'aws_vpc.two', modulePath: [], isData: false, type: 'aws_vpc', name: 'two', index: null },
    ],
    edges: [],
  };

  const result = compileEnvironmentGraph({
    environment: 'data_dev',
    repoGraphs: [ambiguousGraph, infraGraph()],
    crossRepoLinks: [{ fromKind: 'aws.eks.cluster', toKind: 'aws.vpc', label: 'runs in' }],
  });

  assert.equal(result.edges.some((e) => e.label === 'runs in'), false);
  assert.deepEqual(result.unresolvedCrossRepoLinks, [
    { fromKind: 'aws.eks.cluster', toKind: 'aws.vpc', fromCount: 1, toCount: 2 },
  ]);
});
