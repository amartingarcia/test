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

/* ---- `link` rules: a helper resource that is not drawn but whose references become an edge ---- */
{
  const node = (type, name) => ({ address: `${type}.${name}`, modulePath: [], isData: false, type, name, index: null });
  const manifest = {
    repoId: 'r',
    rules: [
      { match: { type: 'azurerm_subnet' }, entity: { kind: 'azure.subnet', idFrom: 'name' } },
      { match: { type: 'azurerm_network_security_group' }, entity: { kind: 'azure.nsg', idFrom: 'name' } },
      { match: { type: 'azurerm_subnet_network_security_group_association' }, link: { fromType: 'azurerm_subnet', toType: 'azurerm_network_security_group', label: 'secured by' } },
    ],
  };
  const nodes = [node('azurerm_subnet', 'a'), node('azurerm_network_security_group', 'n'), node('azurerm_subnet_network_security_group_association', 'x')];
  const ref = (from, to) => ({ from, to });

  test('link rule: the helper is not drawn or reported as unmapped, and its two references become a labelled edge', () => {
    const g = compileEnvironmentGraph({ environment: 'e', repoGraphs: [{ repoId: 'r', manifest, nodes, edges: [
      ref('azurerm_subnet_network_security_group_association.x', 'azurerm_subnet.a'),
      ref('azurerm_subnet_network_security_group_association.x', 'azurerm_network_security_group.n'),
    ] }] });
    assert.deepEqual(g.entities.map((e) => e.kind).sort(), ['azure.nsg', 'azure.subnet']);
    assert.deepEqual(g.coverage.r.unmapped, []);
    assert.deepEqual(g.edges, [{ from: 'r:azure.subnet:a', to: 'r:azure.nsg:n', label: 'secured by' }]);
  });

  test('link rule: a chain (A -> helper -> B) is followed in the dependency direction', () => {
    const m = { repoId: 'r', rules: [
      { match: { type: 'aws_instance' }, entity: { kind: 'aws.ec2.instance', idFrom: 'name' } },
      { match: { type: 'aws_iam_role' }, entity: { kind: 'aws.iam.role', idFrom: 'name' } },
      { match: { type: 'aws_iam_instance_profile' }, link: { fromType: 'aws_instance', toType: 'aws_iam_role', label: 'assumes' } },
    ] };
    const ns = [node('aws_instance', 'i'), node('aws_iam_role', 'r1'), node('aws_iam_instance_profile', 'p')];
    const g = compileEnvironmentGraph({ environment: 'e', repoGraphs: [{ repoId: 'r', manifest: m, nodes: ns, edges: [ref('aws_instance.i', 'aws_iam_instance_profile.p'), ref('aws_iam_instance_profile.p', 'aws_iam_role.r1')] }] });
    assert.deepEqual(g.edges, [{ from: 'r:aws.ec2.instance:i', to: 'r:aws.iam.role:r1', label: 'assumes' }]);
  });

  test('link rule: when one side is missing it is reported, not guessed', () => {
    const g = compileEnvironmentGraph({ environment: 'e', repoGraphs: [{ repoId: 'r', manifest, nodes: nodes.slice(0, 1).concat(nodes[2]), edges: [ref('azurerm_subnet_network_security_group_association.x', 'azurerm_subnet.a')] }] });
    assert.deepEqual(g.edges, []);
    assert.ok(g.findings.some((f) => f.type === 'link-not-resolved'));
  });
}
