import { test } from 'node:test';
import assert from 'node:assert/strict';

import { candidatePools } from '../lib/k8s/scheduling.mjs';

const pools = [
  { name: 'general', labels: { workload: 'general', 'karpenter.sh/nodepool': 'general' }, requirements: [{ key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] }], taints: [] },
  { name: 'spot', labels: { 'karpenter.sh/nodepool': 'spot' }, requirements: [{ key: 'karpenter.sh/capacity-type', operator: 'In', values: ['spot'] }], taints: [{ key: 'batch', value: 'true', effect: 'NoSchedule' }] },
  { name: 'system', labels: { 'node-role': 'system' }, requirements: [], taints: [{ key: 'CriticalAddonsOnly', effect: 'NoSchedule' }] },
];
const names = (r) => r.candidates.map((p) => p.name);

test('nodeSelector on a pool label resolves to exactly that pool', () => {
  const r = candidatePools({ nodeSelector: { workload: 'general' } }, pools);
  assert.deepEqual(names(r), ['general']);
  assert.equal(r.status, 'resolved');
});

test('no selector: only pools without untolerated taints qualify', () => {
  const r = candidatePools({}, pools);
  assert.deepEqual(names(r), ['general']);
});

test('tolerations open up tainted pools; several candidates = ambiguous, never a guess', () => {
  const r = candidatePools({ tolerations: [{ key: 'batch', operator: 'Exists' }] }, pools);
  assert.deepEqual(names(r), ['general', 'spot']);
  assert.equal(r.status, 'ambiguous');
});

test('capacity-type via nodeSelector matches requirements', () => {
  const r = candidatePools({ nodeSelector: { 'karpenter.sh/capacity-type': 'spot' }, tolerations: [{ key: 'batch', value: 'true', effect: 'NoSchedule' }] }, pools);
  assert.deepEqual(names(r), ['spot']);
});

test('required node affinity: In / NotIn / Exists', () => {
  const aff = (exprs) => ({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: exprs }] } } } });
  assert.deepEqual(names(candidatePools(aff([{ key: 'workload', operator: 'In', values: ['general', 'x'] }]), pools)), ['general']);
  assert.deepEqual(names(candidatePools({ ...aff([{ key: 'karpenter.sh/capacity-type', operator: 'NotIn', values: ['spot'] }]) }, pools)), ['general']);
  assert.deepEqual(names(candidatePools({ ...aff([{ key: 'node-role', operator: 'Exists' }]), tolerations: [{ operator: 'Exists' }] }, pools)), ['system']);
});

test('nothing compatible is reported as such', () => {
  const r = candidatePools({ nodeSelector: { gpu: 'a100' } }, pools);
  assert.equal(r.status, 'none');
});

test('constructs we do not evaluate make the answer unknown, not wrong', () => {
  const r = candidatePools({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'a', operator: 'Gt', values: ['1'] }] }] } } } }, pools);
  assert.equal(r.status, 'unknown');
  const fields = candidatePools({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: ['n'] }] }] } } } }, pools);
  assert.equal(fields.status, 'unknown');
});

test('a toleration with empty key and Exists tolerates every taint', () => {
  assert.equal(candidatePools({ tolerations: [{ operator: 'Exists' }] }, pools).candidates.length, 3);
});

test('Karpenter labels are never satisfied by a static node group', () => {
  const mixed = [
    { name: 'karp', labels: {}, requirements: [], taints: [] },
    { name: 'mng', labels: {}, requirements: [], taints: [], static: true },
  ];
  assert.deepEqual(candidatePools({ nodeSelector: { 'karpenter.sh/capacity-type': 'spot' } }, mixed).candidates.map((p) => p.name), ['karp']);
});
