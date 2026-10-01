import { candidatePools } from './scheduling.mjs';
import { isObject } from './load-manifests.mjs';

/**
 * Turns parsed Kubernetes objects into the same compound-graph shape the
 * viewer already renders (entities with `parent`, edges, coverage), in one of
 * two views of the same cluster:
 *   'namespace' - cluster > namespace > workloads/services/config, ArgoCD apps
 *   'nodes'     - cluster > node pool (Karpenter NodePool / node group) > workloads
 *
 * Principle (as everywhere in this project): resolve unambiguously or report.
 * A workload only nests in a pool when exactly one pool can host it; a
 * relation is only drawn when it is evident in the manifests.
 *
 * @param {object} options
 * @param {string} options.environment
 * @param {string} options.clusterName
 * @param {import('./load-manifests.mjs').K8sObject[]} options.objects
 * @param {'namespace'|'nodes'} options.view
 * @param {{name: string, labels?: Record<string,string>, taints?: object[], uncertain?: boolean}[]} [options.nodeGroups] managed node groups known from the cloud layer
 */
export function buildK8sGraph({ environment, clusterName, objects, view, nodeGroups = [] }) {
  const entities = [];
  const edges = [];
  const findings = [];
  const unresolvedPlacements = [];
  const unmapped = new Set();
  const nodesView = view === 'nodes';

  const val = (value) => ({ resolved: true, value });
  const unres = (raw) => ({ resolved: false, raw });
  const put = (details, key, value) => { if (value !== undefined && value !== null && value !== '') details[key] = val(value); };
  const entityId = (kind, name) => `k8s:${kind}:${name}`;
  const nsName = (o) => `${o.namespace ?? 'default'}/${o.name}`;
  const byId = new Map();
  const add = (e) => { entities.push(e); byId.set(e.id, e); return e; };
  const link = (from, to, label) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    if (!edges.some((e) => e.from === from && e.to === to)) edges.push(label ? { from, to, label } : { from, to });
  };
  const finding = (type, id, message) => findings.push({ type, entityId: id, message });
  const src = (o) => `${o.source.path}`;

  const cluster = add({ id: entityId('k8s.cluster', clusterName), kind: 'k8s.cluster', parent: null, repoId: 'k8s', sourceAddress: clusterName, details: { name: val(clusterName), objects: val(objects.length) } });

  const of = (...kinds) => objects.filter((o) => kinds.includes(o.kind));
  const IGNORED = new Set([
    'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'NetworkPolicy', 'CustomResourceDefinition',
    'ValidatingWebhookConfiguration', 'MutatingWebhookConfiguration', 'PriorityClass', 'StorageClass', 'ResourceQuota',
    'LimitRange', 'APIService', 'Endpoints', 'EndpointSlice', 'Event', 'ReplicaSet', 'Pod' /* handled below */,
  ]);
  IGNORED.delete('Pod');
  const ABSORBED = new Set(['ServiceAccount', 'HorizontalPodAutoscaler', 'PodDisruptionBudget']);
  const WORKLOADS = { Deployment: 'k8s.deployment', StatefulSet: 'k8s.statefulset', DaemonSet: 'k8s.daemonset', CronJob: 'k8s.cronjob', Job: 'k8s.job', Pod: 'k8s.pod' };

  /* ---------------------------------------------------------- capacity */

  const pools = [];
  for (const o of of('EC2NodeClass')) {
    const s = o.spec ?? {};
    const details = {};
    put(details, 'amiFamily', s.amiFamily);
    put(details, 'ami', (s.amiSelectorTerms ?? []).map((t) => t.alias ?? t.id ?? t.name).filter(Boolean).join(', '));
    put(details, 'role', s.role);
    add({ id: entityId('k8s.nodeclass', o.name), kind: 'k8s.nodeclass', parent: cluster.id, repoId: 'k8s', sourceAddress: src(o), details });
  }
  for (const o of of('NodePool')) {
    const t = o.spec?.template ?? {};
    const labels = { ...(t.metadata?.labels ?? {}), 'karpenter.sh/nodepool': o.name };
    const requirements = (t.spec?.requirements ?? []).map((r) => ({ key: r.key, operator: r.operator, values: (r.values ?? []).map(String) }));
    const taints = t.spec?.taints ?? [];
    const details = {};
    put(details, 'capacity', requirements.map((r) => `${shortKey(r.key)} ${r.operator === 'In' ? '=' : r.operator} ${(r.values ?? []).join('|')}`.trim()).join(' · '));
    put(details, 'taints', taints.map(taintText).join(', '));
    put(details, 'labels', Object.entries(t.metadata?.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
    put(details, 'limits', Object.entries(o.spec?.limits ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
    put(details, 'consolidation', o.spec?.disruption?.consolidationPolicy);
    const e = add({ id: entityId('k8s.nodepool', o.name), kind: 'k8s.nodepool', parent: cluster.id, repoId: 'k8s', sourceAddress: src(o), details });
    pools.push({ name: o.name, id: e.id, labels, requirements, taints });
    const cls = t.spec?.nodeClassRef?.name;
    if (cls) {
      if (byId.has(entityId('k8s.nodeclass', cls))) link(e.id, entityId('k8s.nodeclass', cls), 'uses');
      else finding('missing-reference', e.id, `NodePool ${o.name} references EC2NodeClass ${cls}, which is not in the manifests`);
    }
  }
  for (const g of nodeGroups) {
    const details = {};
    put(details, 'labels', Object.entries(g.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
    put(details, 'taints', (g.taints ?? []).map(taintText).join(', '));
    const e = add({ id: entityId('k8s.nodegroup', g.name), kind: 'k8s.nodegroup', parent: cluster.id, repoId: 'k8s', sourceAddress: g.name, details });
    pools.push({ name: g.name, id: e.id, labels: g.labels ?? {}, requirements: [], taints: g.taints ?? [], uncertain: g.uncertain === true, static: true });
  }

  /* ------------------------------------------------------- namespaces */

  const nsEntities = new Map();
  const ensureNamespace = (name, declared) => {
    const id = entityId('k8s.namespace', name);
    if (nsEntities.has(name)) {
      if (declared) nsEntities.get(name).details.declared = val(true);
      return nsEntities.get(name);
    }
    const e = { id, kind: 'k8s.namespace', parent: cluster.id, repoId: 'k8s', sourceAddress: name, details: { declared: val(declared) } };
    nsEntities.set(name, e);
    if (!nodesView) add(e);
    return e;
  };
  for (const o of of('Namespace')) ensureNamespace(o.name, true);

  /* -------------------------------------------------------- workloads */

  const podSpecOf = (o) => (o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : o.kind === 'Pod' ? o.spec : o.spec?.template?.spec) ?? {};
  const podLabelsOf = (o) => (o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.metadata?.labels : o.kind === 'Pod' ? o.labels : o.spec?.template?.metadata?.labels) ?? {};

  const sas = new Map(of('ServiceAccount').map((o) => [nsName(o), o]));
  const workloadObjects = objects.filter((o) => WORKLOADS[o.kind]);
  const workloads = [];
  for (const o of workloadObjects) {
    const spec = podSpecOf(o);
    const containers = [...(spec.initContainers ?? []), ...(spec.containers ?? [])];
    const main = spec.containers ?? [];
    const details = {};
    put(details, 'namespace', o.namespace ?? 'default');
    if (typeof o.spec?.replicas === 'number') put(details, 'replicas', o.spec.replicas);
    if (o.kind === 'CronJob') put(details, 'schedule', o.spec?.schedule);
    put(details, 'image', main[0]?.image);
    if (main.length > 1) put(details, 'containers', main.map((c) => `${c.name} (${c.image ?? '?'})`).join(', '));
    put(details, 'requests', main.map((c) => requestsText(c)).filter(Boolean).join('; '));
    put(details, 'ports', main.flatMap((c) => (c.ports ?? []).map((p) => `${p.containerPort}/${p.protocol ?? 'TCP'}`)).join(', '));
    const sa = spec.serviceAccountName;
    if (sa) {
      put(details, 'serviceAccount', sa);
      const sao = sas.get(`${o.namespace ?? 'default'}/${sa}`);
      put(details, 'iamRole', sao?.annotations?.['eks.amazonaws.com/role-arn']);
      put(details, 'gcpServiceAccount', sao?.annotations?.['iam.gke.io/gcp-service-account']);
    }
    put(details, 'nodeSelector', Object.entries(spec.nodeSelector ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
    put(details, 'tolerations', (spec.tolerations ?? []).map((t) => t.key ?? '*').join(', '));
    if (o.kind === 'StatefulSet') put(details, 'storage', (o.spec?.volumeClaimTemplates ?? []).map((v) => v.spec?.resources?.requests?.storage).filter(Boolean).join(', '));
    const e = { id: entityId(WORKLOADS[o.kind], nsName(o)), kind: WORKLOADS[o.kind], parent: null, repoId: 'k8s', sourceAddress: src(o), details };
    add(e);
    workloads.push({ obj: o, entity: e, spec, labels: podLabelsOf(o), containers });
  }
  const workloadByRef = (ns, kind, name) => workloads.find((w) => w.obj.kind === kind && w.obj.name === name && (w.obj.namespace ?? 'default') === ns);

  // HPA / PDB are properties of the workload they target
  for (const h of of('HorizontalPodAutoscaler')) {
    const ref = h.spec?.scaleTargetRef ?? {};
    const w = workloadByRef(h.namespace ?? 'default', ref.kind, ref.name);
    if (!w) { finding('missing-reference', entityId('k8s.hpa', nsName(h)), `HPA ${nsName(h)} targets ${ref.kind}/${ref.name}, which is not in the manifests`); continue; }
    put(w.entity.details, 'hpa', `${h.spec?.minReplicas ?? 1}-${h.spec?.maxReplicas}`);
  }
  for (const p of of('PodDisruptionBudget')) {
    const sel = p.spec?.selector?.matchLabels ?? {};
    for (const w of workloads.filter((x) => (x.obj.namespace ?? 'default') === (p.namespace ?? 'default') && Object.keys(sel).length && subset(sel, x.labels))) {
      put(w.entity.details, 'pdb', p.spec?.minAvailable !== undefined ? `minAvailable ${p.spec.minAvailable}` : `maxUnavailable ${p.spec?.maxUnavailable}`);
    }
  }

  /* ---------------------------------------- scheduling (both views) */

  for (const w of workloads) {
    const isDaemon = w.obj.kind === 'DaemonSet';
    const res = candidatePools(w.spec, pools);
    const names = res.candidates.map((p) => p.name);
    const e = w.entity;
    if (res.status === 'resolved') put(e.details, 'runsOn', names[0]);
    else if (isDaemon) put(e.details, 'runsOn', names.length ? `every node (${names.join(', ')})` : 'every node');
    else if (pools.length) e.details.runsOn = unres(res.status === 'ambiguous' ? names.join(' | ') : res.status === 'none' ? 'no compatible pool' : 'not evaluated (affinity)');

    if (!nodesView) { e.parent = null; continue; }
    if (res.status === 'resolved' && !isDaemon) e.parent = res.candidates[0].id;
    else {
      e.parent = cluster.id;
      if (!isDaemon && pools.length) unresolvedPlacements.push({ entityId: e.id, reason: res.status, candidates: names });
    }
  }

  /* ------------------------------------------------ namespace view only */

  const argoApps = new Map();
  if (!nodesView) {
    const NS_KINDS = {
      Service: 'k8s.service', Ingress: 'k8s.ingress', ConfigMap: 'k8s.configmap', Secret: 'k8s.secret', PersistentVolumeClaim: 'k8s.pvc',
    };
    for (const w of workloads) w.entity.parent = ensureNamespace(w.obj.namespace ?? 'default', false).id;

    for (const o of objects.filter((x) => NS_KINDS[x.kind])) {
      const details = {};
      const s = o.spec ?? {};
      if (o.kind === 'Service') {
        put(details, 'type', s.type ?? 'ClusterIP');
        put(details, 'ports', (s.ports ?? []).map((p) => `${p.port}${p.targetPort !== undefined ? `→${p.targetPort}` : ''}/${p.protocol ?? 'TCP'}`).join(', '));
        put(details, 'selector', Object.entries(s.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
      } else if (o.kind === 'Ingress') {
        put(details, 'class', s.ingressClassName ?? o.annotations['kubernetes.io/ingress.class']);
        put(details, 'hosts', (s.rules ?? []).map((r) => r.host).filter(Boolean).join(', '));
      } else if (o.kind === 'PersistentVolumeClaim') {
        put(details, 'storage', s.resources?.requests?.storage);
        put(details, 'storageClass', s.storageClassName);
      }
      add({ id: entityId(NS_KINDS[o.kind], nsName(o)), kind: NS_KINDS[o.kind], parent: ensureNamespace(o.namespace ?? 'default', false).id, repoId: 'k8s', sourceAddress: src(o), details });
    }

    // service -> workloads whose pod labels satisfy the selector
    for (const o of of('Service')) {
      const sel = o.spec?.selector;
      if (!isObject(sel) || !Object.keys(sel).length) continue;
      const id = entityId('k8s.service', nsName(o));
      const targets = workloads.filter((w) => (w.obj.namespace ?? 'default') === (o.namespace ?? 'default') && subset(sel, w.labels));
      if (!targets.length) finding('service-without-workload', id, `Service ${nsName(o)} selects no workload in its namespace`);
      for (const t of targets) link(id, t.entity.id);
    }
    // ingress -> services
    for (const o of of('Ingress')) {
      const id = entityId('k8s.ingress', nsName(o));
      const ns = o.namespace ?? 'default';
      const backends = [];
      for (const r of o.spec?.rules ?? []) for (const p of r.http?.paths ?? []) backends.push({ name: p.backend?.service?.name, label: `${r.host ?? '*'}${p.path ?? ''}` });
      if (o.spec?.defaultBackend?.service?.name) backends.push({ name: o.spec.defaultBackend.service.name, label: 'default' });
      for (const b of backends) {
        if (!b.name) continue;
        const sid = entityId('k8s.service', `${ns}/${b.name}`);
        if (byId.has(sid)) link(id, sid, b.label); else finding('missing-reference', id, `Ingress ${nsName(o)} routes to Service ${ns}/${b.name}, which is not in the manifests`);
      }
    }
    // workload -> configmap / secret / pvc
    for (const w of workloads) {
      const ns = w.obj.namespace ?? 'default';
      for (const ref of podRefs(w.spec, w.containers)) {
        const id = entityId(ref.kind, `${ns}/${ref.name}`);
        if (byId.has(id)) link(w.entity.id, id);
        else if (!ref.optional) finding('missing-reference', w.entity.id, `${w.obj.kind} ${nsName(w.obj)} references ${ref.kind.replace('k8s.', '')} ${ns}/${ref.name}, which is not in the manifests`);
      }
    }

    /* --------------------------------------------------------- ArgoCD */
    addArgo();
  }

  function addArgo() {
    const newApp = (ns, name, spec, extra, o) => {
      const s = spec.sources?.[0] ?? spec.source ?? {};
      const dest = spec.destination ?? {};
      const details = {};
      put(details, 'source', s.repoURL ? `${s.repoURL} · ${s.chart ?? s.path ?? ''}@${s.targetRevision ?? 'HEAD'}` : undefined);
      put(details, 'destination', dest.namespace ? `${dest.namespace} @ ${dest.name ?? dest.server ?? '?'}` : undefined);
      const auto = spec.syncPolicy?.automated;
      put(details, 'sync', auto ? ['automated', auto.prune ? 'prune' : null, auto.selfHeal ? 'selfHeal' : null].filter(Boolean).join(' · ') : 'manual');
      for (const [k, v] of Object.entries(extra)) put(details, k, v);
      const e = add({ id: entityId('k8s.argo.application', `${ns}/${name}`), kind: 'k8s.argo.application', parent: ensureNamespace(ns, false).id, repoId: 'k8s', sourceAddress: o ? src(o) : `appset:${extra.generatedBy}`, details });
      argoApps.set(name, e);
      // only a destination in this very cluster is a relation we can draw; anything else stays as text
      const inCluster = !dest.server && !dest.name ? true : dest.server === 'https://kubernetes.default.svc' || dest.name === 'in-cluster';
      if (dest.namespace && inCluster && !String(dest.namespace).includes('{{')) { ensureNamespace(dest.namespace, false); link(e.id, entityId('k8s.namespace', dest.namespace), 'deploys to'); }
      return e;
    };

    for (const o of of('Application')) newApp(o.namespace ?? 'argocd', o.name, o.spec ?? {}, {}, o);

    for (const o of of('ApplicationSet')) {
      const ns = o.namespace ?? 'argocd';
      const setId = entityId('k8s.argo.applicationset', `${ns}/${o.name}`);
      const gens = o.spec?.generators ?? [];
      const details = {};
      const lists = gens.filter((g) => g.list && Array.isArray(g.list.elements));
      const other = gens.filter((g) => !(g.list && Array.isArray(g.list.elements)));
      const set = add({ id: setId, kind: 'k8s.argo.applicationset', parent: ensureNamespace(ns, false).id, repoId: 'k8s', sourceAddress: src(o), details });
      let count = 0;
      for (const g of lists) {
        for (const el of g.list.elements) {
          const rendered = render(o.spec?.template ?? {}, el);
          const name = rendered.metadata?.name;
          if (typeof name !== 'string' || name.includes('{{')) { finding('applicationset-not-expanded', setId, `ApplicationSet ${o.name}: template name could not be resolved for an element`); continue; }
          if (argoApps.has(name)) { finding('duplicate', setId, `ApplicationSet ${o.name} generates ${name}, which already exists`); continue; }
          const app = newApp(rendered.metadata?.namespace ?? ns, name, rendered.spec ?? {}, { generatedBy: o.name }, null);
          link(setId, app.id, 'generates');
          count++;
        }
      }
      if (other.length) {
        const kinds = other.map((g) => Object.keys(g)[0]).join(', ');
        details.generates = unres(`${kinds} generator (not expanded offline)`);
        finding('applicationset-not-expanded', setId, `ApplicationSet ${o.name} uses generator(s) ${kinds}: the applications it produces are unknown offline`);
      } else put(details, 'generates', `${count} application(s)`);
      void set;
    }

    // which applications own which objects: only the explicit tracking label/annotation
    for (const w of workloads) {
      const app = trackedApp(w.obj);
      if (!app) continue;
      put(w.entity.details, 'argoApp', app);
      const a = argoApps.get(app);
      if (a) link(a.id, w.entity.id, 'manages');
    }
    for (const e of entities.filter((x) => ['k8s.service', 'k8s.ingress', 'k8s.configmap', 'k8s.secret', 'k8s.pvc'].includes(x.kind))) {
      const o = objects.find((x) => entityId(kindOf(x.kind), nsName(x)) === e.id);
      const app = o && trackedApp(o);
      if (app) put(e.details, 'argoApp', app);
    }
  }

  /* ---------------------------------------------------------- coverage */

  const handled = new Set([
    'Namespace', 'EC2NodeClass', 'NodePool', 'Application', 'ApplicationSet', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'PersistentVolumeClaim',
    ...Object.keys(WORKLOADS), ...ABSORBED, ...IGNORED,
  ]);
  for (const o of objects) if (!handled.has(o.kind)) unmapped.add(label(o));

  return {
    environment,
    view,
    entities,
    edges,
    coverage: { k8s: { unmapped: [...unmapped], unresolvedBoundaries: [] } },
    unresolvedCrossRepoLinks: [],
    unresolvedPlacements,
    findings,
    legend: nodesView
      ? { default: 'Cluster', compute: 'Node pools', k8s: 'Workloads' }
      : { default: 'Cluster', net: 'Namespaces', compute: 'Capacity', k8s: 'Workloads', edgeapp: 'Services & ingress', cfg: 'Config & storage', eks: 'ArgoCD' },
  };
}

const label = (o) => `${o.kind} ${o.namespace ? `${o.namespace}/` : ''}${o.name}`;
const subset = (sel, labels) => Object.entries(sel).every(([k, v]) => String(labels[k]) === String(v));
const shortKey = (k) => k.split('/').pop();
const taintText = (t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`;
const requestsText = (c) => {
  const r = c.resources?.requests;
  return r ? [r.cpu, r.memory].filter(Boolean).join(' / ') : '';
};

function podRefs(spec, containers) {
  const refs = [];
  const push = (kind, name, optional) => { if (name) refs.push({ kind, name, optional: optional === true }); };
  for (const c of containers) {
    for (const f of c.envFrom ?? []) {
      if (f.configMapRef) push('k8s.configmap', f.configMapRef.name, f.configMapRef.optional);
      if (f.secretRef) push('k8s.secret', f.secretRef.name, f.secretRef.optional);
    }
    for (const e of c.env ?? []) {
      const from = e.valueFrom ?? {};
      if (from.configMapKeyRef) push('k8s.configmap', from.configMapKeyRef.name, from.configMapKeyRef.optional);
      if (from.secretKeyRef) push('k8s.secret', from.secretKeyRef.name, from.secretKeyRef.optional);
    }
  }
  for (const v of spec.volumes ?? []) {
    if (v.configMap) push('k8s.configmap', v.configMap.name, v.configMap.optional);
    if (v.secret) push('k8s.secret', v.secret.secretName, v.secret.optional);
    if (v.persistentVolumeClaim) push('k8s.pvc', v.persistentVolumeClaim.claimName);
    for (const s of v.projected?.sources ?? []) {
      if (s.configMap) push('k8s.configmap', s.configMap.name, s.configMap.optional);
      if (s.secret) push('k8s.secret', s.secret.name, s.secret.optional);
    }
  }
  return refs;
}

/** ApplicationSet template substitution: `{{key}}`, `{{ key }}`, `{{ .key }}` for scalar list elements. */
function render(node, element) {
  if (typeof node === 'string') {
    return node.replace(/\{\{\s*\.?([\w.-]+)\s*\}\}/g, (m, key) => (Object.hasOwn(element, key) && typeof element[key] !== 'object' ? String(element[key]) : m));
  }
  if (Array.isArray(node)) return node.map((n) => render(n, element));
  if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, render(v, element)]));
  return node;
}

const trackedApp = (o) => o.labels['argocd.argoproj.io/instance'] ?? ((o.annotations['argocd.argoproj.io/tracking-id'] ?? '').split(':')[0] || null);
const kindOf = (k) => ({ Service: 'k8s.service', Ingress: 'k8s.ingress', ConfigMap: 'k8s.configmap', Secret: 'k8s.secret', PersistentVolumeClaim: 'k8s.pvc' }[k]);
