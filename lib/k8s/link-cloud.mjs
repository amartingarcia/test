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

/** @returns {{ nodeGroups: {name: string, labels: object, taints: object[], uncertain?: boolean}[], warnings: string[] }} */
export function nodeGroupsFromCloud(entities) {
  const nodeGroups = [];
  const warnings = [];
  for (const e of entities.filter((x) => x.kind === 'aws.eks.nodegroup')) {
    const d = e.details ?? {};
    const name = val(d, 'node_group_name') ?? tail(e.id);
    let uncertain = false;

    let labels = {};
    if (d.labels) {
      if (d.labels.resolved && d.labels.value && typeof d.labels.value === 'object') labels = d.labels.value;
      else { uncertain = true; warnings.push(`node group ${name}: labels could not be resolved (${d.labels.raw ?? 'not an object'})`); }
    }

    const taints = new Map();
    for (const [key, entry] of Object.entries(d)) {
      const m = /^taint(?:\[(\d+)\])?\.(key|value|effect)$/.exec(key);
      if (!m) continue;
      const slot = m[1] ?? '0';
      if (!entry.resolved) { uncertain = true; warnings.push(`node group ${name}: ${key} could not be resolved`); continue; }
      taints.set(slot, { ...(taints.get(slot) ?? {}), [m[2]]: entry.value });
    }
    const taintList = [...taints.values()].map((t) => ({ key: t.key, value: t.value, effect: EFFECTS[t.effect] ?? t.effect }));

    nodeGroups.push({ name, labels, taints: taintList, ...(uncertain ? { uncertain } : {}) });
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
  const clusters = cloud.entities.filter((e) => e.kind === 'aws.eks.cluster');
  if (clusters.length !== 1) throw new Error(`mergeK8sIntoCloud needs exactly one aws.eks.cluster entity in the cloud graph (found ${clusters.length})`);
  const cluster = clusters[0];

  const dropped = new Set(cloud.entities.filter((e) => dropRepos.includes(e.repoId)).map((e) => e.id));
  const cloudEntities = cloud.entities.filter((e) => !dropped.has(e.id));
  const cloudNodeGroups = new Map(cloudEntities.filter((e) => e.kind === 'aws.eks.nodegroup').map((e) => [val(e.details, 'node_group_name') ?? tail(e.id), e.id]));

  // k8s ids that stand for something the cloud graph already has
  const remap = new Map();
  const findings = [...(cloud.findings ?? []), ...(k8s.findings ?? [])];
  for (const e of k8s.entities) {
    if (e.kind === 'k8s.cluster') remap.set(e.id, cluster.id);
    else if (e.kind === 'k8s.nodegroup') {
      const target = cloudNodeGroups.get(tail(e.id));
      if (target) remap.set(e.id, target);
      else findings.push({ type: 'nodegroup-not-in-cloud', entityId: e.id, message: `node group ${tail(e.id)} is not in the cloud graph` });
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
