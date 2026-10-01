import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';

test('parses multi-doc manifests and flattens List kinds', () => {
  const { objects, errors } = loadK8sManifests([{ path: 'a.yaml', content: `
apiVersion: v1
kind: Namespace
metadata: {name: shop}
---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ConfigMap
    metadata: {name: c, namespace: shop, labels: {a: b}}
` }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(objects.map((o) => `${o.kind}/${o.namespace ?? '-'}/${o.name}`), ['Namespace/-/shop', 'ConfigMap/shop/c']);
  assert.deepEqual(objects[1].labels, { a: 'b' });
});

test('Secret payloads never leave the loader', () => {
  const { objects } = loadK8sManifests([{ path: 's.yaml', content: 'apiVersion: v1\nkind: Secret\nmetadata: {name: s, namespace: x}\ndata:\n  password: c2VjcmV0\nstringData:\n  token: abc\n' }]);
  assert.equal(JSON.stringify(objects).includes('c2VjcmV0'), false);
  assert.equal(JSON.stringify(objects).includes('abc'), false);
});

test('unparseable files are reported with path and line, other files still load', () => {
  const { objects, errors } = loadK8sManifests([
    { path: 'bad.yaml', content: 'a: &x 1\n' },
    { path: 'ok.yaml', content: 'apiVersion: v1\nkind: Namespace\nmetadata: {name: n}\n' },
  ]);
  assert.equal(objects.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'bad.yaml');
  assert.match(errors[0].message, /line 1/);
});

test('documents that are not Kubernetes objects are ignored', () => {
  const { objects } = loadK8sManifests([{ path: 'v.yaml', content: 'replicaCount: 2\nimage: {tag: x}\n' }]);
  assert.deepEqual(objects, []);
});
