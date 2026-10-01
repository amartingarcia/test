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
      const name = val(d, 'node_group_name') ?? tail(e.id);
      const l = labelsFrom(d, 'labels', name, warnings);
      const t = taintsFrom(d, '', name, warnings);
      push(name, l.labels, t.taints, l.uncertain || t.uncertain, source);
    } else if (e.kind === 'azure.aks.nodepool') {
      const name = val(d, 'name') ?? tail(e.id);
      const l = labelsFrom(d, 'node_labels', name, warnings);
      const t = azureTaints(d, 'node_taints', name, warnings);
      push(name, { ...l.labels, 'kubernetes.azure.com/agentpool': name }, t.taints, l.uncertain || t.uncertain, source);
    } else if (e.kind === 'gcp.gke.nodepool') {
      const name = val(d, 'name') ?? tail(e.id);
      const l = labelsFrom(d, 'node_config.labels', name, warnings);
      const t = taintsFrom(d, 'node_config.', name, warnings);
      const spot = val(d, 'node_config.spot') === true ? { 'cloud.google.com/gke-spot': 'true' } : {};
      push(name, { ...l.labels, ...spot, 'cloud.google.com/gke-nodepool': name }, t.taints, l.uncertain || t.uncertain, source);
    } else {
      const name = val(d, 'name') ?? tail(e.id);
      const l = ociLabels(d, name, warnings);
      push(name, { ...l.labels }, [], l.uncertain, source);
    }
  }

  // AKS default pool lives inside the cluster resource
  for (const c of entities.filter((x) => x.kind === 'azure.aks.cluster')) {
    const d = c.details ?? {};
    const name = val(d, 'default_node_pool.name');
    if (!name) continue;
    const l = labelsFrom(d, 'default_node_pool.node_labels', name, warnings);
    const t = azureTaints(d, 'default_node_pool.node_taints', name, warnings);
    const critical = d['default_node_pool.only_critical_addons_enabled'];
    let uncertain = l.uncertain || t.uncertain;
    const taints = [...t.taints];
    if (critical && !critical.resolved) { uncertain = true; warnings.push(`node pool ${name}: only_critical_addons_enabled could not be resolved`); }
    else if (critical?.value === true) taints.push({ key: 'CriticalAddonsOnly', value: 'true', effect: 'NoSchedule' });
    push(name, { ...l.labels, 'kubernetes.azure.com/agentpool': name }, taints, uncertain, { clusterId: c.id });
  }
  return { nodeGroups, warnings };
}

/**
 * @param {object} options
 * @param {string} options.environment id of the merged graph
 * @param {object} options.cloud compiled cloud graph (compileEnvironmentGraph output)
 * @param {object} options.k8s   buildK8sGraph output (built with nodeGroups from nodeGroupsFromCloud)
 * @param {string[]} [options.dropRepos] cloud repos to leave out (e.g. a GitOps repo superseded by the manifests)
 */
export function mergeK8sIntoCloud({ environment, cloud, k8s, dropRepos = [] }) {
  const clusters = cloud.entities.filter((e) => CLUSTER_KINDS.includes(e.kind));
  if (clusters.length !== 1) throw new Error(`mergeK8sIntoCloud needs exactly one Kubernetes cluster entity (${CLUSTER_KINDS.join(', ')}) in the cloud graph (found ${clusters.length})`);
  const cluster = clusters[0];

  const dropped = new Set(cloud.entities.filter((e) => dropRepos.includes(e.repoId)).map((e) => e.id));
  const cloudEntities = cloud.entities.filter((e) => !dropped.has(e.id));
  const cloudPools = new Map(nodeGroupsFromCloud(cloudEntities).nodeGroups.map((g) => [g.name, g.source]));

  // k8s ids that stand for something the cloud graph already has
  const remap = new Map();
  const findings = [...(cloud.findings ?? []), ...(k8s.findings ?? [])];
  for (const e of k8s.entities) {
    if (e.kind === 'k8s.cluster') remap.set(e.id, cluster.id);
    else if (e.kind === 'k8s.nodegroup') {
      const source = cloudPools.get(tail(e.id));
      if (source?.entityId) remap.set(e.id, source.entityId);
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
  const roles = new Map(cloudEntities.filter((e) => e.kind.startsWith('aws.iam.role')).map((e) => [val(e.details, 'name'), e.id]).filter(([n]) => n));
  const link = (from, roleName, label, type) => {
    const role = roles.get(roleName);
    if (role) edges.push({ from, to: role, label });
    else findings.push({ type, entityId: from, message: `role ${roleName} (used by ${tail(from)}) is not in the cloud graph` });
  };
  for (const e of k8sEntities) {
    const arn = val(e.details, 'iamRole');
    if (arn) link(e.id, String(arn).split('/').pop(), 'assumes (IRSA)', 'irsa-role-not-found');
    const gsa = val(e.details, 'gcpServiceAccount');
    if (gsa) {
      const account = String(gsa).split('@')[0];
      const target = cloudEntities.find((x) => x.kind === 'gcp.service_account' && val(x.details, 'account_id') === account);
      if (target) edges.push({ from: e.id, to: target.id, label: 'impersonates (Workload Identity)' });
      else findings.push({ type: 'gsa-not-found', entityId: e.id, message: `service account ${account} (used by ${tail(e.id)}) is not in the cloud graph` });
    }
    const nodeRole = e.kind === 'k8s.nodeclass' ? val(e.details, 'role') : undefined;
    if (nodeRole) link(e.id, nodeRole, 'node role', 'node-role-not-found');
  }

  return {
    environment,
    entities: [...cloudEntities, ...k8sEntities],
    edges,
    coverage: { ...cloud.coverage, ...k8s.coverage },
    unresolvedCrossRepoLinks: cloud.unresolvedCrossRepoLinks ?? [],
    unresolvedPlacements: [...(cloud.unresolvedPlacements ?? []).filter((u) => !dropped.has(u.entityId)), ...k8s.unresolvedPlacements],
    findings,
    legend: { net: 'Network / namespaces', compute: 'Compute / capacity', eks: 'EKS / ArgoCD', k8s: 'Workloads', edgeapp: 'DNS, LB & services', cfg: 'Config & storage' },
  };
}
