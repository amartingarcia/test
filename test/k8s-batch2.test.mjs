import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';
import { candidatePools } from '../lib/k8s/scheduling.mjs';
import { mergeK8sIntoCloud, nodeGroupsFromCloud } from '../lib/k8s/link-cloud.mjs';

const load = (yaml) => loadK8sManifests([{ path: 't.yaml', content: yaml }]);
const build = (yaml, extra = {}) => {
  const { objects, errors } = load(yaml);
  assert.deepEqual(errors, []);
  return buildK8sGraph({ environment: 'e', clusterName: 'c1', objects, view: 'namespace', ...extra });
};
const hasEdge = (g, from, to) => g.edges.find((e) => e.from === from && e.to === to);

/* ---- loader ---- */
test('loader: a manifest without metadata.name (generateName) is reported, not dropped silently', () => {
  const { objects, errors } = load('apiVersion: batch/v1\nkind: Job\nmetadata:\n  generateName: run-\n');
  assert.equal(objects.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Job/);
  assert.match(errors[0].message, /metadata\.name/);
});

/* ---- Karpenter API group ---- */
test('a NodePool of another API group is not read as Karpenter', () => {
  const g = build('apiVersion: example.com/v1\nkind: NodePool\nmetadata: {name: other}\nspec: {}\n');
  assert.equal(g.entities.some((e) => e.kind === 'k8s.nodepool'), false);
  assert.ok(g.coverage.k8s.unmapped.some((u) => u.includes('NodePool other')));
  const k = build('apiVersion: karpenter.sh/v1\nkind: NodePool\nmetadata: {name: real}\nspec: {template: {spec: {}}}\n');
  assert.ok(k.entities.some((e) => e.kind === 'k8s.nodepool'));
});

/* ---- Argo ---- */
const ARGO = (extra = '') => `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: web, namespace: argocd}
spec:
  destination: {server: "https://kubernetes.default.svc", namespace: shop}
  sources:
    - {repoURL: "https://example.com/chart.git", chart: web, targetRevision: 1.0.0}
    - {repoURL: "https://example.com/values.git", ref: values, targetRevision: main}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  ${extra}
spec:
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec: {containers: [{name: web, image: nginx}]}
`;

test('argo: tracking through app.kubernetes.io/instance counts only when that Argo app exists', () => {
  const g = build(ARGO('labels: {app.kubernetes.io/instance: web}'));
  assert.ok(hasEdge(g, 'k8s:k8s.argo.application:argocd/web', 'k8s:k8s.deployment:shop/web'));
  const none = build(ARGO('labels: {app.kubernetes.io/instance: not-an-argo-app}'));
  assert.equal(none.entities.find((e) => e.id === 'k8s:k8s.deployment:shop/web').details.argoApp, undefined);
});

test('argo: every source of a multi-source application is listed', () => {
  const g = build(ARGO());
  const src = g.entities.find((e) => e.kind === 'k8s.argo.application').details.source.value;
  assert.match(src, /chart\.git/);
  assert.match(src, /values\.git/);
});

test('argo: same-named applications in different namespaces are not confused', () => {
  const two = `${ARGO('annotations: {"argocd.argoproj.io/tracking-id": "web:apps/Deployment:shop/web"}')}
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: web, namespace: team-b}
spec:
  destination: {server: "https://kubernetes.default.svc", namespace: other}
  source: {repoURL: "https://example.com/b.git", path: .}
`;
  const g = build(two);
  assert.equal(g.entities.filter((e) => e.kind === 'k8s.argo.application').length, 2);
  assert.equal(g.edges.some((e) => e.label === 'manages'), false);
  assert.ok(g.findings.some((f) => f.type === 'argo-app-ambiguous'));
});

test('argo: an unresolved ApplicationSet placeholder outside the name stays unresolved', () => {
  const g = build(`
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: {name: set, namespace: argocd}
spec:
  generators: [{list: {elements: [{name: a}]}}]
  template:
    metadata: {name: "{{name}}"}
    spec:
      destination: {server: "https://kubernetes.default.svc", namespace: "{{x.y}}"}
      source: {repoURL: "https://example.com/r.git", path: .}
`);
  const app = g.entities.find((e) => e.kind === 'k8s.argo.application');
  assert.equal(app.details.destination.resolved, false);
  assert.equal(g.entities.some((e) => e.id.includes('{{')), false);
});

/* ---- namespaces, coverage, PDB, HPA, ingress ---- */
test('objects without metadata.namespace are reported once, as assumed to be in default', () => {
  const g = build('apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: a}\nspec: {template: {spec: {containers: []}}}\n---\napiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec: {}\n');
  const f = g.findings.filter((x) => x.type === 'namespace-assumed');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /2 object/);
});

test('ignored kinds are counted in coverage so a reader knows they were seen', () => {
  const g = build('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: a, namespace: x}\nspec: {}\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: b, namespace: x}\nspec: {}\n');
  assert.deepEqual(g.coverage.k8s.ignored, { NetworkPolicy: 2 });
  assert.deepEqual(g.coverage.k8s.unmapped, []);
});

test('PDB with matchExpressions or an empty selector is reported, not silently ignored', () => {
  const g = build(`${ARGO()}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: p1, namespace: shop}
spec: {minAvailable: 1, selector: {matchExpressions: [{key: app, operator: In, values: [web]}]}}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: p2, namespace: shop}
spec: {minAvailable: 1, selector: {}}
`);
  assert.equal(g.findings.filter((f) => f.type === 'pdb-not-evaluated').length, 2);
});

test('HPA without maxReplicas does not print undefined', () => {
  const g = build(`${ARGO()}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: web, namespace: shop}
spec: {scaleTargetRef: {kind: Deployment, name: web}, minReplicas: 2}
`);
  assert.equal(g.entities.find((e) => e.id === 'k8s:k8s.deployment:shop/web').details.hpa.value, '2-?');
});

test('ingress: tls secret is linked (or reported), backend.resource is reported, several paths to one service keep every label', () => {
  const g = build(`
apiVersion: v1
kind: Service
metadata: {name: web, namespace: shop}
spec: {selector: {app: web}}
---
apiVersion: v1
kind: Secret
metadata: {name: web-tls, namespace: shop}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: ing, namespace: shop}
spec:
  tls: [{secretName: web-tls}, {secretName: missing-tls}]
  rules:
    - host: a.example.com
      http: {paths: [{path: /, pathType: Prefix, backend: {service: {name: web, port: {number: 80}}}}, {path: /x, pathType: Prefix, backend: {resource: {kind: StorageBucket, name: b, apiGroup: example.com}}}]}
    - host: b.example.com
      http: {paths: [{path: /, pathType: Prefix, backend: {service: {name: web, port: {number: 80}}}}]}
`);
  assert.ok(hasEdge(g, 'k8s:k8s.ingress:shop/ing', 'k8s:k8s.secret:shop/web-tls'));
  assert.ok(g.findings.some((f) => f.type === 'missing-reference' && /missing-tls/.test(f.message)));
  assert.ok(g.findings.some((f) => f.type === 'ingress-backend-resource'));
  const svc = hasEdge(g, 'k8s:k8s.ingress:shop/ing', 'k8s:k8s.service:shop/web');
  assert.match(svc.label, /a\.example\.com\//);
  assert.match(svc.label, /b\.example\.com\//);
});

/* ---- scheduling: OR-ed node selector terms ---- */
const pool = (name, labels) => ({ name, labels, requirements: [], taints: [] });
const terms = (...ts) => ({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: ts } } } });
const expr = (key, ...values) => ({ matchExpressions: [{ key, operator: 'In', values }] });

test('scheduling: several nodeSelectorTerms are OR-ed', () => {
  const pools = [pool('a', { tier: 'a' }), pool('b', { tier: 'b' }), pool('c', { tier: 'c' })];
  const r = candidatePools(terms(expr('tier', 'a'), expr('tier', 'b')), pools);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map((p) => p.name), ['a', 'b']);
  assert.equal(candidatePools(terms(expr('tier', 'a'), expr('tier', 'zzz')), pools).status, 'resolved');
});

test('scheduling: an empty term matches nothing (Kubernetes semantics)', () => {
  assert.equal(candidatePools(terms({}), [pool('a', {})]).status, 'none');
});

/* ---- cloud <-> k8s join ---- */
const v = (value) => ({ resolved: true, value });
const cluster = (id, name) => ({ id: `p:aws.eks.cluster:${id}`, kind: 'aws.eks.cluster', parent: null, repoId: 'p', details: { name: v(name) } });
const cloudBase = (entities, extra = {}) => ({ environment: 'x', entities, edges: [], coverage: { p: { unmapped: [], unresolvedBoundaries: [] } }, unresolvedCrossRepoLinks: [], unresolvedPlacements: [], findings: [], legend: { default: 'Accounts', eks: 'EKS' }, ...extra });
const k8sFor = (name) => buildK8sGraph({ environment: 'k', clusterName: name, objects: load('apiVersion: v1\nkind: Namespace\nmetadata: {name: shop}\n').objects, view: 'namespace' });

test('join: clusterName picks one of several clusters; no match still refuses', () => {
  const cloud = cloudBase([cluster('a', 'prod-a'), cluster('b', 'prod-b')]);
  const g = mergeK8sIntoCloud({ environment: 'm', cloud, k8s: k8sFor('prod-b'), clusterName: 'prod-b' });
  assert.equal(g.entities.find((e) => e.kind === 'k8s.namespace').parent, 'p:aws.eks.cluster:b');
  assert.throws(() => mergeK8sIntoCloud({ environment: 'm', cloud, k8s: k8sFor('x'), clusterName: 'nope' }), /exactly one/);
  assert.throws(() => mergeK8sIntoCloud({ environment: 'm', cloud, k8s: k8sFor('x') }), /exactly one/);
});

test('join: the legend keeps the cloud entries (an AKS/GKE/OKE label is not overwritten by "EKS")', () => {
  const cloud = cloudBase([cluster('a', 'c')], { legend: { default: 'Accounts', eks: 'AKS', iam: 'Identity' } });
  const g = mergeK8sIntoCloud({ environment: 'm', cloud, k8s: k8sFor('c') });
  assert.equal(g.legend.iam, 'Identity');
  assert.match(g.legend.eks, /AKS/);
  assert.match(g.legend.eks, /ArgoCD/);
});

test('join: dropped repos are removed from coverage, findings and cross-repo reports too', () => {
  const entities = [cluster('a', 'c'), { id: 'g:k8s.release.service:x', kind: 'k8s.release.service', parent: null, repoId: 'gitops', details: {} }];
  const cloud = cloudBase(entities, {
    coverage: { p: { unmapped: [], unresolvedBoundaries: [] }, gitops: { unmapped: ['helm_release.y'], unresolvedBoundaries: [] } },
    findings: [{ type: 'f', entityId: 'g:k8s.release.service:x', message: 'm' }],
    unresolvedCrossRepoLinks: [{ fromKind: 'k8s.release.service', toKind: 'x', fromCount: 1, toCount: 0 }],
  });
  const g = mergeK8sIntoCloud({ environment: 'm', cloud, k8s: k8sFor('c'), dropRepos: ['gitops'] });
  assert.equal(g.coverage.gitops, undefined);
  assert.equal(g.findings.some((f) => f.entityId === 'g:k8s.release.service:x'), false);
  assert.deepEqual(g.unresolvedCrossRepoLinks, []);
});

test('join: duplicate role names and unresolved role names are told apart from "not in the cloud graph"', () => {
  const role = (id, name) => ({ id: `p:aws.iam.role.workload:${id}`, kind: 'aws.iam.role.workload', parent: null, repoId: 'p', details: name ? { name: v(name) } : { name: { resolved: false, raw: 'var.n' } } });
  const cloud = cloudBase([cluster('a', 'c'), role('r1', 'dup'), role('r2', 'dup'), role('r3', null)]);
  const yaml = (arn) => `
apiVersion: v1
kind: ServiceAccount
metadata: {name: sa, namespace: shop, annotations: {eks.amazonaws.com/role-arn: "${arn}"}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop}
spec: {template: {spec: {serviceAccountName: sa, containers: []}}}
`;
  const run = (arn) => {
    const { objects } = load(yaml(arn));
    const k8s = buildK8sGraph({ environment: 'k', clusterName: 'c', objects, view: 'namespace' });
    return mergeK8sIntoCloud({ environment: 'm', cloud, k8s });
  };
  const dup = run('arn:aws:iam::1:role/dup');
  assert.ok(dup.findings.some((f) => f.type === 'irsa-role-ambiguous'));
  assert.equal(dup.edges.some((e) => e.label?.includes('IRSA')), false);
  const missing = run('arn:aws:iam::1:role/zzz');
  assert.ok(missing.findings.some((f) => f.type === 'irsa-role-not-found' && /unresolved/.test(f.message)));
});

void nodeGroupsFromCloud;
