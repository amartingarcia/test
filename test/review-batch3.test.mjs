import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlDocuments } from '../lib/yaml/parse-yaml.mjs';
import { candidatePools } from '../lib/k8s/scheduling.mjs';
import { nodeGroupsFromCloud } from '../lib/k8s/link-cloud.mjs';

test('YAML 1.2 core booleans/null spellings', () => {
  assert.deepEqual(parseYamlDocuments('a: True\nb: FALSE\nc: Null\n')[0], { a: true, b: false, c: null });
});

test('unsupported YAML constructs fail loudly instead of corrupting data', () => {
  assert.throws(() => parseYamlDocuments('a: |2\n    x\n   y\n'), /indentation indicators/);
  assert.throws(() => parseYamlDocuments('a: [b: c]\n'), /single-pair flow/);
});

test('pool NotIn requirement excludes a pool for an In selector', () => {
  const pools = [{ name: 'od', labels: {}, requirements: [{ key: 'karpenter.sh/capacity-type', operator: 'NotIn', values: ['spot'] }], taints: [] }];
  assert.equal(candidatePools({ nodeSelector: { 'karpenter.sh/capacity-type': 'spot' } }, pools).status, 'none');
});

test('toleration and label values compare as strings', () => {
  const pools = [{ name: 'p', labels: { gpu: 'true' }, requirements: [], taints: [{ key: 't', value: 'true', effect: 'NoSchedule' }] }];
  assert.equal(candidatePools({ nodeSelector: { gpu: true }, tolerations: [{ key: 't', value: true, effect: 'NoSchedule' }] }, pools).status, 'resolved');
});

test('EKS nodes carry the nodegroup label; AKS default pool is system; unresolved default pool name is uncertain', () => {
  const v = (value) => ({ resolved: true, value });
  const { nodeGroups } = nodeGroupsFromCloud([
    { id: 'a', kind: 'aws.eks.nodegroup', details: { node_group_name: v('ng') } },
    { id: 'c', kind: 'azure.aks.cluster', details: { 'default_node_pool.name': v('sys') } },
    { id: 'd', kind: 'azure.aks.cluster', details: { 'default_node_pool.name': { resolved: false, raw: 'var.x' } } },
  ]);
  assert.equal(nodeGroups.find((g) => g.name === 'ng').labels['eks.amazonaws.com/nodegroup'], 'ng');
  assert.equal(nodeGroups.find((g) => g.name === 'sys').labels['kubernetes.azure.com/mode'], 'system');
  assert.equal(nodeGroups.find((g) => g.name === '(default pool)').uncertain, true);
});
