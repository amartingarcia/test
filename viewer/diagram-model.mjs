// Pure model shared by the interactive viewer (app.js), the SVG renderer and the
// standalone HTML export: compiled graph + catalog -> boxes, edges and layout config.
// No DOM, no Cytoscape: testable in Node (test/diagram-model.test.mjs).

import { layoutLanes } from './lanes-layout.mjs';

export const CLASSES = ['net', 'compute', 'eks', 'k8s', 'data', 'iam', 'cfg', 'edgeapp', 'default'];
export const CLASS_NAMES = { net: 'Network', compute: 'Compute', eks: 'EKS', k8s: 'Workloads', data: 'Data stores', iam: 'IAM', cfg: 'Config', edgeapp: 'DNS & LB', default: 'Other' };

export const KIND_CLASS = (kind) => {
  if (kind.startsWith('aws.eks')) return 'eks';
  if (kind.startsWith('aws.iam') || kind.startsWith('group.iam')) return 'iam';
  if (kind.startsWith('aws.ec2')) return 'compute';
  if (kind.startsWith('aws.ssm') || kind.startsWith('group.ssm') || kind.startsWith('group.secrets') || kind.startsWith('group.storage')) return 'cfg';
  if (kind.startsWith('aws.route53') || kind.startsWith('aws.lb')) return 'edgeapp';
  if (kind.startsWith('aws.rds') || kind.startsWith('aws.docdb') || kind.startsWith('aws.dynamodb') || kind.startsWith('aws.elasticache') || kind.startsWith('aws.opensearch')) return 'data';
  const cloud = /^(azure|gcp|oci)\.(.+)$/.exec(kind);
  if (cloud) {
    const r = cloud[2];
    if (/^(resource_group|compartment)$/.test(r)) return 'default';
    if (/^(vnet|vpc|vcn|subnet|nat|nat_gateway|router|firewall|nsg|route_table|security_list|public_ip|internet_gateway|service_gateway)$/.test(r)) return 'net';
    if (/^(aks|gke|oke)\./.test(r)) return 'eks';
    if (/^(vm|instance)$/.test(r)) return 'compute';
    if (/^(postgres|sql|redis|cosmos|mysql|adb)/.test(r)) return 'data';
    if (/^(lb|appgw|dns|private_endpoint)/.test(r)) return 'edgeapp';
    if (/^(identity|service_account|iam|policy|dynamic_group)/.test(r)) return 'iam';
    return 'cfg';
  }
  if (kind === 'k8s.cluster') return 'default';
  if (kind === 'k8s.namespace') return 'net';
  if (/^k8s\.(nodepool|nodeclass|nodegroup)$/.test(kind)) return 'compute';
  if (/^k8s\.(service|ingress)$/.test(kind)) return 'edgeapp';
  if (/^k8s\.(configmap|secret|pvc)$/.test(kind)) return 'cfg';
  if (kind.startsWith('k8s.argo')) return 'eks';
  if (kind.startsWith('k8s.')) return 'k8s';
  if (/^aws\.(vpc|subnet|nat|internet|route_table|security_group)/.test(kind)) return 'net';
  return 'default';
};

/** Exact kind, then longest dotted prefix (mirror of lib/catalog/spec-for-kind.mjs). */
export function specForKind(catalog, kind) {
  const parts = kind.split('.');
  for (let n = parts.length; n > 0; n--) {
    const spec = catalog.kinds?.[parts.slice(0, n).join('.')];
    if (spec) return spec;
  }
  return {};
}

export const isGroupKind = (kind) => kind.startsWith('group.');
export const groupOfKind = (catalog, kind) => (isGroupKind(kind) ? catalog.groups?.[kind.slice('group.'.length)] : null);

export const CARD = { w: 176, h: 64 };
export const CHIP = { w: 208, h: 50 };
export const sizeOfKind = (catalog, kind) => (specForKind(catalog, kind).size === 'chip' ? CHIP : CARD);

export const resolved = (details, key) => (details?.[key]?.resolved ? details[key].value : undefined);
const kindShort = (kind) => kind.split('.').slice(1).join('.');

export function entityName(entity) {
  const rawName = entity.id.split(':').slice(2).join(':');
  return rawName.includes('.') ? rawName.split('.').pop() : rawName;
}

/** Name shown on a container's tab; a cluster also shows its version and the addons it owns. */
function groupLabel(entity, embeddedOf) {
  const first = `${kindShort(entity.kind)} · ${entityName(entity)}`;
  const owned = embeddedOf.get(entity.id);
  if (!owned?.length) return first;
  const version = resolved(entity.details, 'version');
  const names = owned.map((o) => resolved(o.details, 'addon_name') ?? entityName(o));
  return `${first}\n${version ? `v${version} · ` : ''}addons: ${names.join(', ')}`;
}

/** true when `maybeAncestor` contains `id` anywhere up its parent chain. */
function isAncestor(byId, maybeAncestor, id) {
  for (let cur = byId.get(id)?.parent, guard = 0; cur && guard < 20; cur = byId.get(cur)?.parent, guard++) {
    if (cur === maybeAncestor) return true;
  }
  return false;
}

/**
 * Compiled graph -> drawable nodes (leaves and containers) and edges.
 * Embedded entities (e.g. EKS addons) are properties of their parent, not boxes; edges that
 * only restate containment, or touch an embedded entity, are dropped.
 */
export function buildDiagram(graph, catalog) {
  const nodes = [];
  const edges = [];
  const visible = graph.entities.filter((e) => !e.embedded);
  const byId = new Map(graph.entities.map((e) => [e.id, e]));

  const embeddedOf = new Map();
  for (const e of graph.entities) {
    if (!e.embedded || !e.parent) continue;
    if (!embeddedOf.has(e.parent)) embeddedOf.set(e.parent, []);
    embeddedOf.get(e.parent).push(e);
  }

  // Global groups from the catalog (IAM is account-wide, so it sits outside any VPC).
  const groupIds = new Set();
  const groupOf = (e) => {
    const gid = specForKind(catalog, e.kind).group;
    return gid && !e.parent ? `group:${gid}` : null;
  };
  for (const e of visible) { const g = groupOf(e); if (g) groupIds.add(g); }
  for (const gid of groupIds) {
    const key = gid.slice('group:'.length);
    nodes.push({ id: gid, kind: gid.replace(':', '.'), name: key, w: CARD.w, h: CARD.h, class: KIND_CLASS(`group.${key}`), groupLabel: catalog.groups?.[key]?.label ?? key });
  }

  for (const entity of visible) {
    const parentKind = byId.get(entity.parent)?.kind ?? '';
    // Kubernetes ids are ns/name: the namespace is shown by the container (or the sub line), not in the title
    const name = entity.kind.startsWith('k8s.') && entity.kind !== 'k8s.cluster' ? entityName(entity).split('/').pop() : entityName(entity);
    const size = sizeOfKind(catalog, entity.kind);
    nodes.push({
      id: entity.id,
      name,
      w: size.w,
      h: size.h,
      parentKind,
      groupLabel: groupLabel(entity, embeddedOf),
      kind: entity.kind,
      parent: entity.parent ?? groupOf(entity) ?? undefined,
      repoId: entity.repoId,
      sourceAddress: entity.sourceAddress,
      details: entity.details ?? null,
      embedded: (embeddedOf.get(entity.id) ?? []).map((o) => ({ name: resolved(o.details, 'addon_name') ?? entityName(o), details: o.details ?? null })),
      class: KIND_CLASS(entity.kind),
    });
  }

  const shown = new Set(visible.map((e) => e.id));
  for (const [i, edge] of graph.edges.entries()) {
    const to = byId.get(edge.to);
    if (!shown.has(edge.from) || !shown.has(edge.to)) continue;
    if (isAncestor(byId, edge.to, edge.from) || isAncestor(byId, edge.from, edge.to)) continue;
    edges.push({ id: `e${i}`, source: edge.from, target: edge.to, label: edge.label ?? '', cls: to ? KIND_CLASS(to.kind) : 'default' });
  }
  return { nodes, edges };
}

/** Layout config shared by the viewer and the static renderer. */
export function layoutConfigFor(catalog, vertical = false) {
  const flip = (axis) => (vertical ? (axis === 'row' ? 'column' : 'row') : axis);
  return {
    sizeOf: (kind) => sizeOfKind(catalog, kind),
    rootAxis: flip('row'),
    axisOf: (kind) => flip(groupOfKind(catalog, kind)?.axis ?? specForKind(catalog, kind).axis ?? 'column'),
    orderOf: (n) => groupOfKind(catalog, n.kind)?.order ?? specForKind(catalog, n.kind).order ?? 50,
    gap: 44,
    pad: 30,
    padTop: 50,
    wrap: { min: 6, aspect: 1.5 }, // crowded containers (e.g. 10 namespaces) become a grid instead of one endless line
  };
}

/** Absolute boxes ({x,y,w,h}, top-left) for every node, in the orientation that suits `aspect` (w/h). */
export function layoutDiagram(nodes, catalog, { vertical, aspect = 1.6 } = {}) {
  const input = nodes.map((n) => ({ id: n.id, parent: n.parent ?? null, kind: n.kind }));
  const run = (v) => {
    const { boxes } = layoutLanes(input, { ...layoutConfigFor(catalog, v), rootWrap: { min: 4, aspect } });
    const all = Object.values(boxes);
    const minX = Math.min(...all.map((b) => b.x)); const minY = Math.min(...all.map((b) => b.y));
    const width = Math.max(...all.map((b) => b.x + b.w)) - minX; const height = Math.max(...all.map((b) => b.y + b.h)) - minY;
    return { boxes, minX, minY, width, height, v };
  };
  let result;
  if (vertical === undefined) {
    const a = run(false); const b = run(true);
    // the orientation that can be drawn larger in a viewport of the given aspect ratio
    const fit = (r) => Math.min(aspect * 1000 / r.width, 1000 / r.height);
    result = fit(b) > fit(a) ? b : a;
  } else result = run(vertical);
  const boxes = {};
  for (const [id, b] of Object.entries(result.boxes)) boxes[id] = { x: b.x - result.minX, y: b.y - result.minY, w: b.w, h: b.h };
  return { boxes, width: result.width, height: result.height, vertical: result.v };
}
