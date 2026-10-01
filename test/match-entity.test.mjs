import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchEntity } from '../lib/manifest/match-entity.mjs';

const vpcNode = { address: 'module.network.aws_vpc.main', modulePath: ['network'], isData: false, type: 'aws_vpc', name: 'main', index: null };
const subnetNode = { address: 'module.network.aws_subnet.private[0]', modulePath: ['network'], isData: false, type: 'aws_subnet', name: 'private', index: 0 };
const eksNode = { address: 'module.eks.aws_eks_cluster.this', modulePath: ['eks'], isData: false, type: 'aws_eks_cluster', name: 'this', index: null };
const amiDataNode = { address: 'data.aws_ami.eks_worker', modulePath: [], isData: true, type: 'aws_ami', name: 'eks_worker', index: null };

test('matches a node by exact resource type', () => {
  const manifest = {
    repoId: 'network',
    rules: [{ match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } }],
  };

  const entity = matchEntity(vpcNode, manifest);
  assert.deepEqual(entity, { kind: 'aws.vpc', id: 'main', boundary: null, embed: false, sourceAddress: vpcNode.address });
});

test('first matching rule wins when multiple rules could apply', () => {
  const manifest = {
    repoId: 'network',
    rules: [
      { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc.generic', idFrom: 'name' } },
      { match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc.never-reached', idFrom: 'name' } },
    ],
  };

  const entity = matchEntity(vpcNode, manifest);
  assert.equal(entity.kind, 'aws.vpc.generic');
});

test('matches by modulePathPrefix combined with type', () => {
  const manifest = {
    repoId: 'infra',
    rules: [
      { match: { modulePathPrefix: ['eks'], type: 'aws_eks_cluster' }, entity: { kind: 'aws.eks.cluster', idFrom: 'name' } },
    ],
  };

  assert.equal(matchEntity(eksNode, manifest).kind, 'aws.eks.cluster');
  assert.equal(matchEntity(vpcNode, manifest), null);
});

test('modulePathPrefix only matches when node modulePath starts with the given prefix', () => {
  const manifest = {
    repoId: 'infra',
    rules: [{ match: { modulePathPrefix: ['eks', 'nodegroup'] }, entity: { kind: 'aws.eks.nodegroup', idFrom: 'name' } }],
  };

  // eksNode's modulePath is ["eks"], not ["eks", "nodegroup"] -> no match
  assert.equal(matchEntity(eksNode, manifest), null);
});

test('matches data sources via isData flag', () => {
  const manifest = {
    repoId: 'infra',
    rules: [{ match: { isData: true, type: 'aws_ami' }, entity: { kind: 'aws.ami.lookup', idFrom: 'name' } }],
  };

  assert.equal(matchEntity(amiDataNode, manifest).kind, 'aws.ami.lookup');
  assert.equal(matchEntity(vpcNode, manifest), null); // vpc is not a data source
});

test('matches by nameRegex', () => {
  const manifest = {
    repoId: 'network',
    rules: [{ match: { type: 'aws_subnet', nameRegex: '^private' }, entity: { kind: 'aws.subnet.private', idFrom: 'address' } }],
  };

  const entity = matchEntity(subnetNode, manifest);
  assert.equal(entity.kind, 'aws.subnet.private');
  assert.equal(entity.id, subnetNode.address); // idFrom: "address"
});

test('idFrom "literal" uses entity.id verbatim', () => {
  const manifest = {
    repoId: 'network',
    rules: [{ match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'literal', id: 'the-one-vpc' } }],
  };

  assert.equal(matchEntity(vpcNode, manifest).id, 'the-one-vpc');
});

test('carries boundary through when the rule declares one', () => {
  const manifest = {
    repoId: 'network',
    rules: [{ match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name', boundary: 'vpc' } }],
  };

  assert.equal(matchEntity(vpcNode, manifest).boundary, 'vpc');
});

test('returns null when no rule matches (unmapped resource)', () => {
  const manifest = { repoId: 'network', rules: [{ match: { type: 'aws_vpc' }, entity: { kind: 'aws.vpc', idFrom: 'name' } }] };
  assert.equal(matchEntity(eksNode, manifest), null);
});

test('matchEntity returns {ignored: true} for an `ignore` rule, so it is not reported as unmapped', () => {
  const manifest = { repoId: 'r', rules: [{ match: { type: 'aws_db_subnet_group' }, ignore: true }] };
  const n = { address: 'aws_db_subnet_group.g', modulePath: [], isData: false, type: 'aws_db_subnet_group', name: 'g', index: null };
  assert.deepEqual(matchEntity(n, manifest), { ignored: true });
});
