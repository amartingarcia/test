import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYamlDocuments } from '../lib/yaml/parse-yaml.mjs';

const one = (text) => parseYamlDocuments(text)[0];

test('block mapping with scalars of every type', () => {
  assert.deepEqual(one('a: 1\nb: 1.5\nc: true\nd: null\ne: ~\nf: hello world\ng: "q: x"\nh: \'it\'\'s\'\ni:\n'), {
    a: 1, b: 1.5, c: true, d: null, e: null, f: 'hello world', g: 'q: x', h: "it's", i: null,
  });
});

test('nested maps, sequences of scalars and sequences of maps', () => {
  const doc = one(`
metadata:
  name: web
  labels:
    app.kubernetes.io/name: web
spec:
  containers:
    - name: a
      image: x:1
      ports:
        - containerPort: 80
    - name: b
      args: ["--x", "--y=1"]
  tolerations:
  - key: k
    operator: Exists
`);
  assert.equal(doc.metadata.labels['app.kubernetes.io/name'], 'web');
  assert.equal(doc.spec.containers.length, 2);
  assert.equal(doc.spec.containers[0].ports[0].containerPort, 80);
  assert.deepEqual(doc.spec.containers[1].args, ['--x', '--y=1']);
  assert.deepEqual(doc.spec.tolerations, [{ key: 'k', operator: 'Exists' }]);
});

test('sequence at the same indent as its key and nested dashes', () => {
  assert.deepEqual(one('a:\n- 1\n- 2\nb:\n  - - x\n    - y\n  - z\n'), { a: [1, 2], b: [['x', 'y'], 'z'] });
});

test('flow collections, including nesting and empty ones', () => {
  assert.deepEqual(one('a: {x: 1, y: [1, 2, {z: "w"}]}\nb: []\nc: {}\n'), { a: { x: 1, y: [1, 2, { z: 'w' }] }, b: [], c: {} });
});

test('multi-line flow sequence', () => {
  assert.deepEqual(one('a: [\n  1,\n  2\n]\nb: 3\n'), { a: [1, 2], b: 3 });
});

test('block scalars: literal, folded, strip and keep', () => {
  const doc = one('a: |\n  l1\n  l2\nb: |-\n  x\nc: >\n  f1\n  f2\nd: |+\n  k\n\ne: 1\n');
  assert.equal(doc.a, 'l1\nl2\n');
  assert.equal(doc.b, 'x');
  assert.equal(doc.c, 'f1 f2\n');
  assert.equal(doc.d, 'k\n\n');
  assert.equal(doc.e, 1);
});

test('comments are ignored, but not inside quotes or URLs', () => {
  assert.deepEqual(one('# top\na: 1 # trailing\nb: "x # y"\nc: http://h/#frag\n'), { a: 1, b: 'x # y', c: 'http://h/#frag' });
});

test('multiple documents, empty ones skipped', () => {
  assert.deepEqual(parseYamlDocuments('---\na: 1\n---\n---\nb: 2\n...\n'), [{ a: 1 }, { b: 2 }]);
});

test('double-quoted escapes', () => {
  assert.equal(one('a: "x\\ny\\t\\"z\\""\n').a, 'x\ny\t"z"');
});

test('values like "500m", "1Gi" and image tags stay strings', () => {
  assert.deepEqual(one('cpu: 500m\nmem: 1Gi\nimg: nginx:1.25\n'), { cpu: '500m', mem: '1Gi', img: 'nginx:1.25' });
});

test('unsupported constructs fail loudly with a line number, never guessed', () => {
  assert.throws(() => one('a: &x 1\nb: *x\n'), /line 1.*anchors/i);
  assert.throws(() => one('a: !!str 1\n'), /tags/i);
  assert.throws(() => one('a: one\n  two\n'), /line 2/);
  assert.throws(() => one('a:\n\tb: 1\n'), /tab/i);
});
