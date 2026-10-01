/**
 * Joins the Kubernetes layer to the cloud (Terraform) layer of the same
 * environment, using only facts present in both graphs:
 *  - managed node groups (name, labels, taints) become scheduling targets
 *  - the k8s cluster and node groups are replaced by the real aws.eks.* entities
 *  - IRSA: a ServiceAccount's `eks.amazonaws.com/role-arn` is matched to an
 *    aws.iam.role.* entity by role name (no match = finding, never a guess)
 */

const EFFECTS = { NO_SCHEDULE: 'NoSchedule', NO_EXECUTE: 'NoExecute', PREFER_NO_SCHEDULE: 'PreferNoSchedule' };
const val = (details, key) => (details?.[key]?.resolved ? details[key].value : undefined);
const tail = (id) => id.split(':').slice(2).join(':');

// Pool name: the resolved `name` attribute; the Terraform label only when no name attribute exists.
// A name that exists but is unresolved is NOT replaced by the label (labels like agentpool depend on it).
function poolName(d, key, e, warnings) {
  if (d[key]?.resolved) return { name: d[key].value, uncertain: false };
  if (d[key]) { warnings.push(`node pool ${tail(e.id)}: ${key} could not be resolved (${d[key].raw ?? 'unknown'})`); return { name: tail(e.id), uncertain: true, unnamed: true }; }
  return { name: tail(e.id), uncertain: false };
}

const CLUSTER_KINDS = ['aws.eks.cluster', 'azure.aks.cluster', 'gcp.gke.cluster', 'oci.oke.cluster'];
const POOL_KINDS = ['aws.eks.nodegroup', 'azure.aks.nodepool', 'gcp.gke.nodepool', 'oci.oke.nodepool'];
const TAINT_STRING = /^([^=:]+)(?:=([^:]*))?:(NoSchedule|NoExecute|PreferNoSchedule)$/;

// Taints as flattened by the extractor: `<prefix>taint[.|[i].]key|value|effect`
function taintsFrom(details, prefix, name, warnings) {
  const slots = new Map();
  let uncertain = false;
  const re = new RegExp(`^${prefix.replace(/\./g, '\\.')}taint(?:\\[(\\d+)\\])?\\.(key|value|effect)$`);
  for (const [key, entry] of Object.entries(details)) {
    const m = re.exec(key);
    if (!m) continue;
    const slot = m[1] ?? '0';
    if (!entry.resolved) { uncertain = true; warnings.push(`node pool ${name}: ${key} could not be resolved`); continue; }
    slots.set(slot, { ...(slots.get(slot) ?? {}), [m[2]]: entry.value });
  }
  // taints we cannot read (dynamic blocks, attribute form) must not read as "no taints"
  const opaque = Object.keys(details).filter((k) => k.startsWith(`${prefix}dynamic.taint`) || k.startsWith('dynamic.taint') || k === `${prefix}taint`);
  if (opaque.length) { uncertain = true; warnings.push(`node pool ${name}: taints are declared in a form that cannot be resolved (${opaque[0]})`); }
  const taints = [...slots.values()].map((t) => ({ key: t.key, value: t.value, effect: EFFECTS[t.effect] ?? t.effect }));
  return { taints, uncertain };
}

// A labels map stored under `key` (an HCL object): resolved object, absent, or uncertain
function labelsFrom(details, key, name, warnings) {
  const entry = details[key];
  if (!entry) return { labels: {}, uncertain: false };
  if (entry.resolved && entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) return { labels: entry.value, uncertain: false };
  warnings.push(`node pool ${name}: ${key} could not be resolved (${entry.raw ?? 'not an object'})`);
  return { labels: {}, uncertain: true };
}

// AKS: node_taints = ["k=v:NoSchedule", ...]
function azureTaints(details, key, name, warnings) {
  const entry = details[key];
  if (!entry) return { taints: [], uncertain: false };
  if (!entry.resolved || !Array.isArray(entry.value)) { warnings.push(`node pool ${name}: ${key} could not be resolved`); return { taints: [], uncertain: true }; }
  const taints = [];
  for (const raw of entry.value) {
    const m = TAINT_STRING.exec(String(raw));
    if (!m) { warnings.push(`node pool ${name}: taint "${raw}" is not in key=value:Effect form`); return { taints: [], uncertain: true }; }
    taints.push({ key: m[1], value: m[2], effect: m[3] });
  }
  return { taints, uncertain: false };
}

// OCI: initial_node_labels { key value } blocks, flattened with or without index
function ociLabels(details, name, warnings) {
  const out = {};
  const idx = new Set();
  for (const key of Object.keys(details)) { const m = /^initial_node_labels(?:\[(\d+)\])?\.key$/.exec(key); if (m) idx.add(m[1]); }
  let uncertain = false;
  for (const i of idx) {
    const p = i === undefined ? 'initial_node_labels' : `initial_node_labels[${i}]`;
    const k = details[`${p}.key`]; const v = details[`${p}.value`];
    if (k?.resolved && v?.resolved) out[k.value] = String(v.value);
    else { uncertain = true; warnings.push(`node pool ${name}: ${p} could not be resolved`); }
  }
  return { labels: out, uncertain };
}

/**
 * Node pools of whichever cloud the graph holds (EKS node groups, AKS pools incl. the
 * default pool, GKE node pools, OKE node pools), as scheduling targets. Each carries
 * `source`: { entityId } when the pool is an entity of the graph, { clusterId } when it
 * is declared inside the cluster resource (AKS default pool).
 * @returns {{ nodeGroups: {name: string, labels: object, taints: object[], uncertain?: boolean, source: object}[], warnings: string[] }}
 */
export function nodeGroupsFromCloud(entities) {
  const nodeGroups = [];
  const warnings = [];
  const push = (name, labels, taints, uncertain, source) => nodeGroups.push({ name, labels, taints, ...(uncertain ? { uncertain } : {}), source });

  for (const e of entities.filter((x) => POOL_KINDS.includes(x.kind))) {
    const d = e.details ?? {};
    const source = { entityId: e.id };
    if (e.kind === 'aws.eks.nodegroup') {
      const n = poolName(d, 'node_group_name', e, warnings);
      const l = labelsFrom(d, 'labels', n.name, warnings);
      const t = taintsFrom(d, '', n.name, warnings);
      // AWS documents eks.amazonaws.com/capacityType on managed node group nodes; the default is ON_DEMAND
      const cap = d.capacity_type;
      let capUncertain = false;
      const capLabel = {};
      if (!cap) capLabel['eks.amazonaws.com/capacityType'] = 'ON_DEMAND';
      else if (cap.resolved) capLabel['eks.amazonaws.com/capacityType'] = String(cap.value);
      else { capUncertain = true; warnings.push(`node pool ${n.name}: capacity_type could not be resolved`); }
      // EKS managed node groups carry eks.amazonaws.com/nodegroup=<name>
      const own = n.unnamed ? {} : { 'eks.amazonaws.com/nodegroup': n.name };
      push(n.name, { ...capLabel, ...own, ...l.labels }, t.taints, n.uncertain || l.uncertain || t.uncertain || capUncertain, source);
    } else if (e.kind === 'azure.aks.nodepool') {
      const n = poolName(d, 'name', e, warnings);
      const l = labelsFrom(d, 'node_labels', n.name, warnings);
      const t = azureTaints(d, 'node_taints', n.name, warnings);
      const implicit = n.unnamed ? {} : { 'kubernetes.azure.com/agentpool': n.name };
      let uncertain = n.uncertain || l.uncertain || t.uncertain;
      const taints = [...t.taints];
      // documented AKS behaviour for Spot pools: label + taint added by the service
      const prio = d.priority;
      if (prio && !prio.resolved) { uncertain = true; warnings.push(`node pool ${n.name}: priority could not be resolved`); }
      else if (prio?.value === 'Spot') {
        implicit['kubernetes.azure.com/scalesetpriority'] = 'spot';
        if (!taints.some((x) => x.key === 'kubernetes.azure.com/scalesetpriority')) taints.push({ key: 'kubernetes.azure.com/scalesetpriority', value: 'spot', effect: 'NoSchedule' });
      }
      // mode defaults to User for node pool resources
      const mode = d.mode;
      if (mode?.resolved) implicit['kubernetes.azure.com/mode'] = String(mode.value).toLowerCase();
      else if (!mode) implicit['kubernetes.azure.com/mode'] = 'user';
      else { uncertain = true; warnings.push(`node pool ${n.name}: mode could not be resolved`); }
      push(n.name, { ...l.labels, ...implicit }, taints, uncertain, source);
    } else if (e.kind === 'gcp.gke.nodepool') {
      const n = poolName(d, 'name', e, warnings);
      const l = labelsFrom(d, 'node_config.labels', n.name, warnings);
      const t = taintsFrom(d, 'node_config.', n.name, warnings);
      let uncertain = n.uncertain || l.uncertain || t.uncertain;
      const spotEntry = d['node_config.spot'];
      if (spotEntry && !spotEntry.resolved) { uncertain = true; warnings.push(`node pool ${n.name}: node_config.spot could not be resolved`); }
      const spot = spotEntry?.value === true ? { 'cloud.google.com/gke-spot': 'true' } : {};
      const preEntry = d['node_config.preemptible'];
      if (preEntry && !preEntry.resolved) { uncertain = true; warnings.push(`node pool ${n.name}: node_config.preemptible could not be resolved`); }
      else if (preEntry?.value === true) spot['cloud.google.com/gke-preemptible'] = 'true';
      const implicit = n.unnamed ? {} : { 'cloud.google.com/gke-nodepool': n.name };
      push(n.name, { ...l.labels, ...spot, ...implicit }, t.taints, uncertain, source);
    } else {
      const n = poolName(d, 'name', e, warnings);
      const l = ociLabels(d, n.name, warnings);
      push(n.name, { ...l.labels }, [], n.uncertain || l.uncertain, source);
    }
  }

  // AKS default pool lives inside the cluster resource
  for (const c of entities.filter((x) => x.kind === 'azure.aks.cluster')) {
    const d = c.details ?? {};
    const nameEntry = d['default_node_pool.name'];
    if (nameEntry && !nameEntry.resolved) {
      warnings.push(`AKS default node pool of ${c.id}: name could not be resolved`);
      push('(default pool)', {}, [], true, { clusterId: c.id });
      continue;
    }
    const name = val(d, 'default_node_pool.name');
    if (!name) continue;
    const l = labelsFrom(d, 'default_node_pool.node_labels', name, warnings);
    const t = azureTaints(d, 'default_node_pool.node_taints', name, warnings);
    const critical = d['default_node_pool.only_critical_addons_enabled'];
    let uncertain = l.uncertain || t.uncertain;
    const taints = [...t.taints];
    if (critical && !critical.resolved) { uncertain = true; warnings.push(`node pool ${name}: only_critical_addons_enabled could not be resolved`); }
    else if (critical?.value === true) taints.push({ key: 'CriticalAddonsOnly', value: 'true', effect: 'NoSchedule' });
    push(name, { ...l.labels, 'kubernetes.azure.com/agentpool': name, 'kubernetes.azure.com/mode': 'system' }, taints, uncertain, { clusterId: c.id });
  }
  return { nodeGroups, warnings };
}

/**
 * @param {object} options
 * @param {string} options.environment id of the merged graph
 * @param {object} options.cloud compiled cloud graph (compileEnvironmentGraph output)
 * @param {object} options.k8s   buildK8sGraph output (built with nodeGroups from nodeGroupsFromCloud)
 * @param {string[]} [options.dropRepos] cloud repos to leave out (e.g. a GitOps repo superseded by the manifests)
 * @param {string} [options.clusterName] which cluster to join when the cloud graph has several (its `name`, or its Terraform name)
 */
export function mergeK8sIntoCloud({ environment, cloud, k8s, dropRepos = [], clusterName }) {
  let clusters = cloud.entities.filter((e) => CLUSTER_KINDS.includes(e.kind));
  if (clusterName) clusters = clusters.filter((e) => val(e.details, 'name') === clusterName || tail(e.id) === clusterName);
  if (clusters.length !== 1) throw new Error(`mergeK8sIntoCloud needs exactly one Kubernetes cluster entity (${CLUSTER_KINDS.join(', ')}) in the cloud graph (found ${clusters.length}${clusterName ? ` named "${clusterName}"` : '; pass clusterName to pick one'})`);
  const cluster = clusters[0];

  const dropped = new Set(cloud.entities.filter((e) => dropRepos.includes(e.repoId)).map((e) => e.id));
  const cloudEntities = cloud.entities.filter((e) => !dropped.has(e.id));
  const poolList = nodeGroupsFromCloud(cloudEntities).nodeGroups;
  const poolCount = new Map();
  for (const g of poolList) poolCount.set(g.name, (poolCount.get(g.name) ?? 0) + 1);
  const cloudPools = new Map(poolList.map((g) => [g.name, g.source]));

  // k8s ids that stand for something the cloud graph already has
  const remap = new Map();
  const findings = [...(cloud.findings ?? []), ...(k8s.findings ?? [])];
  for (const e of k8s.entities) {
    if (e.kind === 'k8s.cluster') remap.set(e.id, cluster.id);
    else if (e.kind === 'k8s.nodegroup') {
      const source = cloudPools.get(tail(e.id));
      if (poolCount.get(tail(e.id)) > 1) findings.push({ type: 'nodegroup-ambiguous', entityId: e.id, message: `node group ${tail(e.id)} matches ${poolCount.get(tail(e.id))} pools in the cloud graph: not linked` });
      else if (source?.entityId) remap.set(e.id, source.entityId);
      else if (!source?.clusterId) findings.push({ type: 'nodegroup-not-in-cloud', entityId: e.id, message: `node group ${tail(e.id)} is not in the cloud graph` });
      // a pool declared inside the cluster resource (AKS default pool) stays drawn as its own box in the cluster
    }
  }
  const to = (id) => remap.get(id) ?? id;

  const k8sEntities = k8s.entities.filter((e) => !remap.has(e.id)).map((e) => ({ ...e, parent: e.parent ? to(e.parent) : e.parent }));
  const edges = [
    ...cloud.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to)),
    ...k8s.edges.map((e) => ({ ...e, from: to(e.from), to: to(e.to) })),
  ];

  // IRSA and node roles: match by role name
  const roleEntities = cloudEntities.filter((e) => e.kind.startsWith('aws.iam.role'));
  const roles = new Map();
  for (const e of roleEntities) { const n = val(e.details, 'name'); if (n) roles.set(n, [...(roles.get(n) ?? []), e.id]); }
  const unresolvedRoles = roleEntities.filter((e) => !val(e.details, 'name')).length;
  const link = (from, roleName, label, type) => {
    const ids = roles.get(roleName) ?? [];
    if (ids.length === 1) edges.push({ from, to: ids[0], label });
    else if (ids.length > 1) findings.push({ type: type.replace('-not-found', '-ambiguous'), entityId: from, message: `role ${roleName} (used by ${tail(from)}) matches ${ids.length} roles in the cloud graph: not linked` });
    else findings.push({ type, entityId: from, message: `role ${roleName} (used by ${tail(from)}) is not in the cloud graph${unresolvedRoles ? ` (${unresolvedRoles} role(s) have an unresolved name, so it may be one of them)` : ''}` });
  };
  for (const e of k8sEntities) {
    const arn = val(e.details, 'iamRole');
    if (arn) link(e.id, String(arn).split('/').pop(), 'annotated to assume (IRSA)', 'irsa-role-not-found');
    const gsa = val(e.details, 'gcpServiceAccount');
    if (gsa) {
      const account = String(gsa).split('@')[0];
      const targets = cloudEntities.filter((x) => x.kind === 'gcp.service_account' && val(x.details, 'account_id') === account);
      if (targets.length === 1) edges.push({ from: e.id, to: targets[0].id, label: 'annotated to impersonate (Workload Identity)' });
      else if (targets.length > 1) findings.push({ type: 'gsa-ambiguous', entityId: e.id, message: `service account ${account} (used by ${tail(e.id)}) matches ${targets.length} service accounts in the cloud graph: not linked` });
      else findings.push({ type: 'gsa-not-found', entityId: e.id, message: `service account ${account} (used by ${tail(e.id)}) is not in the cloud graph` });
    }
    const nodeRole = e.kind === 'k8s.nodeclass' ? val(e.details, 'role') : undefined;
    if (nodeRole) link(e.id, nodeRole, 'node role', 'node-role-not-found');
  }

  // what belongs to dropped repos must not leak through the reports either
  const keptKinds = new Set(cloudEntities.map((e) => e.kind));
  const droppedKinds = new Set(cloud.entities.filter((e) => dropped.has(e.id)).map((e) => e.kind));
  const gone = (kind) => droppedKinds.has(kind) && !keptKinds.has(kind);
  const coverage = Object.fromEntries(Object.entries({ ...cloud.coverage, ...k8s.coverage }).filter(([repo]) => !dropRepos.includes(repo)));
  const cloudLegend = cloud.legend ?? {};
  const legend = { ...(k8s.legend ?? {}), ...cloudLegend };
  if (cluster.kind === 'aws.eks.cluster') legend.eks = cloudLegend.eks ? `${cloudLegend.eks} / ArgoCD` : k8s.legend?.eks ?? 'ArgoCD';

  const seenEdge = new Set();
  const uniqueEdges = edges.filter((e) => { const k = `${e.from}|${e.to}|${e.label ?? ''}`; if (seenEdge.has(k)) return false; seenEdge.add(k); return true; });
  const remapId = (o) => (o.entityId && remap.has(o.entityId) ? { ...o, entityId: remap.get(o.entityId) } : o);

  return {
    environment,
    entities: [...cloudEntities, ...k8sEntities],
    edges: uniqueEdges,
    coverage,
    unresolvedCrossRepoLinks: (cloud.unresolvedCrossRepoLinks ?? []).filter((l) => !gone(l.fromKind) && !gone(l.toKind)),
    unresolvedPlacements: [...(cloud.unresolvedPlacements ?? []).filter((u) => !dropped.has(u.entityId)), ...k8s.unresolvedPlacements].map(remapId),
    findings: findings.filter((f) => !dropped.has(f.entityId)).map(remapId),
    legend,
  };
}
