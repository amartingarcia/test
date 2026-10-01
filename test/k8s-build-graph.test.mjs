import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadK8sManifests } from '../lib/k8s/load-manifests.mjs';
import { buildK8sGraph } from '../lib/k8s/build-k8s-graph.mjs';

const build = (yaml, opts = {}) => {
  const { objects, errors } = loadK8sManifests([{ path: 't.yaml', content: yaml }]);
  assert.deepEqual(errors, []);
  return buildK8sGraph({ environment: 'k8s_test', clusterName: 'c1', objects, view: 'namespace', ...opts });
};
const byKind = (g, kind) => g.entities.filter((e) => e.kind === kind);
const hasEdge = (g, from, to) => g.edges.some((e) => e.from === from && e.to === to);
const id = (kind, name) => `k8s:${kind}:${name}`;

const BASE = `
apiVersion: v1
kind: Namespace
metadata: {name: shop}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop}
spec:
  replicas: 3
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec:
      serviceAccountName: web
      containers:
        - name: web
          image: nginx:1.25
          envFrom: [{configMapRef: {name: web-cfg}}]
          env:
            - name: PW
              valueFrom: {secretKeyRef: {name: web-secret, key: pw}}
---
apiVersion: v1
kind: Service
metadata: {name: web, namespace: shop}
spec: {selector: {app: web}, ports: [{port: 80}]}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: web, namespace: shop}
spec:
  rules:
    - host: shop.example.com
      http: {paths: [{path: /, backend: {service: {name: web, port: {number: 80}}}}]}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: web-cfg, namespace: shop}
---
apiVersion: v1
kind: Secret
metadata: {name: web-secret, namespace: shop}
data: {pw: c2VjcmV0}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web
  namespace: shop
  annotations: {eks.amazonaws.com/role-arn: "arn:aws:iam::111111111111:role/web"}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: web, namespace: shop}
spec: {scaleTargetRef: {kind: Deployment, name: web}, minReplicas: 2, maxReplicas: 10}
`;

test('namespace view: cluster > namespace > workload, with service/ingress/config relations', () => {
  const g = build(BASE);
  const dep = id('k8s.deployment', 'shop/web');
  assert.equal(g.entities.find((e) => e.id === dep).parent, id('k8s.namespace', 'shop'));
  assert.equal(g.entities.find((e) => e.id === id('k8s.namespace', 'shop')).parent, id('k8s.cluster', 'c1'));
  assert.ok(hasEdge(g, id('k8s.service', 'shop/web'), dep));
  assert.ok(hasEdge(g, id('k8s.ingress', 'shop/web'), id('k8s.service', 'shop/web')));
  assert.ok(hasEdge(g, dep, id('k8s.configmap', 'shop/web-cfg')));
  assert.ok(hasEdge(g, dep, id('k8s.secret', 'shop/web-secret')));
});

test('ServiceAccount and HPA are absorbed into the workload details, not drawn or reported unmapped', () => {
  const g = build(BASE);
  assert.equal(byKind(g, 'k8s.serviceaccount').length, 0);
  assert.deepEqual(g.coverage.k8s.unmapped, []);
  const d = g.entities.find((e) => e.id === id('k8s.deployment', 'shop/web')).details;
  assert.equal(d.replicas.value, 3);
  assert.equal(d.image.value, 'nginx:1.25');
  assert.equal(d.iamRole.value, 'arn:aws:iam::111111111111:role/web');
  assert.equal(d.hpa.value, '2-10');
});

test('secrets are listed by name only', () => {
  const g = build(BASE);
  assert.equal(JSON.stringify(g).includes('c2VjcmV0'), false);
  assert.equal(byKind(g, 'k8s.secret').length, 1);
});

test('namespaces referenced but not declared are created and flagged', () => {
  const g = build('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c, namespace: ghost}\n');
  const ns = g.entities.find((e) => e.id === id('k8s.namespace', 'ghost'));
  assert.equal(ns.details.declared.value, false);
});

test('unknown kinds are reported as unmapped, never dropped silently', () => {
  const g = build('apiVersion: example.io/v1\nkind: Widget\nmetadata: {name: w, namespace: x}\n');
  assert.deepEqual(g.coverage.k8s.unmapped, ['Widget x/w']);
});

test('findings: a service with no matching workload, a reference to a missing config', () => {
  const g = build(`
apiVersion: apps/v1
kind: Deployment
metadata: {name: a, namespace: n}
spec:
  template:
    metadata: {labels: {app: a}}
    spec:
      containers: [{name: a, image: x, envFrom: [{configMapRef: {name: nope}}]}]
---
apiVersion: v1
kind: Service
metadata: {name: lonely, namespace: n}
spec: {selector: {app: other}}
`);
  const types = g.findings.map((f) => f.type).sort();
  assert.deepEqual(types, ['missing-reference', 'service-without-workload']);
});

const POOLS = `
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: {name: general}
spec:
  template:
    metadata: {labels: {workload: general}}
    spec:
      nodeClassRef: {group: karpenter.k8s.aws, kind: EC2NodeClass, name: default}
      requirements:
        - {key: karpenter.sh/capacity-type, operator: In, values: [on-demand]}
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: {name: spot}
spec:
  template:
    spec:
      nodeClassRef: {name: default}
      taints: [{key: batch, value: "true", effect: NoSchedule}]
---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata: {name: default}
spec: {amiFamily: AL2023}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: pinned, namespace: n}
spec: {template: {metadata: {labels: {a: p}}, spec: {nodeSelector: {workload: general}, containers: [{name: c, image: i}]}}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: batch, namespace: n}
spec: {template: {metadata: {labels: {a: b}}, spec: {tolerations: [{key: batch, operator: Exists}], containers: [{name: c, image: i}]}}}
---
apiVersion: apps/v1
kind: DaemonSet
metadata: {name: agent, namespace: n}
spec: {template: {metadata: {labels: {a: d}}, spec: {tolerations: [{operator: Exists}], containers: [{name: c, image: i}]}}}
`;

test('Karpenter: nodepool -> nodeclass edge in both views', () => {
  const g = build(POOLS);
  assert.ok(hasEdge(g, id('k8s.nodepool', 'general'), id('k8s.nodeclass', 'default')));
  assert.equal(g.entities.find((e) => e.id === id('k8s.nodepool', 'general')).parent, id('k8s.cluster', 'c1'));
});

test('node view: pinned workload nests in its pool, ambiguous ones are reported, daemonsets sit at the cluster', () => {
  const g = build(POOLS, { view: 'nodes' });
  const parent = (k, n) => g.entities.find((e) => e.id === id(k, n)).parent;
  assert.equal(parent('k8s.deployment', 'n/pinned'), id('k8s.nodepool', 'general'));
  assert.equal(parent('k8s.deployment', 'n/batch'), id('k8s.cluster', 'c1'));
  assert.deepEqual(g.unresolvedPlacements.map((u) => [u.entityId, u.reason, u.candidates]), [[id('k8s.deployment', 'n/batch'), 'ambiguous', ['general', 'spot']]]);
  assert.equal(parent('k8s.daemonset', 'n/agent'), id('k8s.cluster', 'c1'));
  assert.equal(byKind(g, 'k8s.namespace').length, 0);
  assert.equal(byKind(g, 'k8s.service').length, 0);
});

test('namespace view records where a workload runs without drawing it', () => {
  const g = build(POOLS);
  const d = (n) => g.entities.find((e) => e.id === id('k8s.deployment', n)).details.runsOn;
  assert.equal(d('n/pinned').value, 'general');
  assert.equal(d('n/batch').resolved, false);
  assert.match(d('n/batch').raw, /general.*spot/);
});

test('node groups passed in (from the cloud layer) compete as scheduling targets', () => {
  const g = build(`
apiVersion: apps/v1
kind: Deployment
metadata: {name: ctl, namespace: kube-system}
spec: {template: {metadata: {labels: {a: c}}, spec: {nodeSelector: {node-role: system}, tolerations: [{key: CriticalAddonsOnly, operator: Exists}], containers: [{name: c, image: i}]}}}
`, { view: 'nodes', nodeGroups: [{ name: 'system', labels: { 'node-role': 'system' }, taints: [{ key: 'CriticalAddonsOnly', effect: 'NoSchedule' }] }] });
  assert.equal(g.entities.find((e) => e.id === id('k8s.deployment', 'kube-system/ctl')).parent, id('k8s.nodegroup', 'system'));
});

const ARGO = `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: shop, namespace: argocd}
spec:
  source: {repoURL: "https://git.example.com/shop.git", path: deploy, targetRevision: main}
  destination: {server: "https://kubernetes.default.svc", namespace: shop}
  syncPolicy: {automated: {prune: true, selfHeal: true}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop, labels: {argocd.argoproj.io/instance: shop}}
spec: {template: {metadata: {labels: {a: w}}, spec: {containers: [{name: c, image: i}]}}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: stray, namespace: shop}
spec: {template: {metadata: {labels: {a: s}}, spec: {containers: [{name: c, image: i}]}}}
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: {name: tenants, namespace: argocd}
spec:
  generators:
    - list:
        elements:
          - {name: tenant-a, ns: ta}
          - {name: tenant-b, ns: tb}
  template:
    metadata: {name: "{{name}}-app"}
    spec:
      source: {repoURL: "https://git.example.com/t.git", path: "{{name}}"}
      destination: {server: "https://kubernetes.default.svc", namespace: "{{ns}}"}
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: {name: dynamic, namespace: argocd}
spec:
  generators: [{git: {repoURL: "https://git.example.com/x.git", directories: [{path: "apps/*"}]}}]
  template: {metadata: {name: "{{path.basename}}"}, spec: {destination: {namespace: x}}}
`;

test('ArgoCD: application -> destination namespace and managed workloads (by tracking label only)', () => {
  const g = build(ARGO);
  const app = id('k8s.argo.application', 'argocd/shop');
  assert.ok(hasEdge(g, app, id('k8s.namespace', 'shop')));
  assert.ok(hasEdge(g, app, id('k8s.deployment', 'shop/web')));
  assert.equal(hasEdge(g, app, id('k8s.deployment', 'shop/stray')), false);
  const web = g.entities.find((e) => e.id === id('k8s.deployment', 'shop/web'));
  assert.equal(web.details.argoApp.value, 'shop');
  const appEntity = g.entities.find((e) => e.id === app);
  assert.match(appEntity.details.source.value, /deploy@main/);
  assert.match(appEntity.details.sync.value, /prune/);
});

test('ArgoCD ApplicationSet: list generator is expanded, other generators are reported as unresolved', () => {
  const g = build(ARGO);
  const set = id('k8s.argo.applicationset', 'argocd/tenants');
  assert.ok(g.entities.some((e) => e.id === id('k8s.argo.application', 'argocd/tenant-a-app')));
  assert.ok(hasEdge(g, set, id('k8s.argo.application', 'argocd/tenant-b-app')));
  assert.ok(hasEdge(g, id('k8s.argo.application', 'argocd/tenant-a-app'), id('k8s.namespace', 'ta')));
  const dyn = g.entities.find((e) => e.id === id('k8s.argo.applicationset', 'argocd/dynamic'));
  assert.equal(dyn.details.generates.resolved, false);
  assert.ok(g.findings.some((f) => f.type === 'applicationset-not-expanded' && f.entityId === dyn.id));
});
