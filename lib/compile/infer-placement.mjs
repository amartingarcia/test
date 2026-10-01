import { extractResourceDetails } from '../extract/extract-resource-details.mjs';
import { parseResourceAddress } from '../parse/parse-resource-address.mjs';
import { specForKind } from '../catalog/spec-for-kind.mjs';

const MAX_DEPTH = 4;
// `aws_subnet.data_b` in an expression; not `data.aws_x.y`, `var.x`, `local.x`
// (no underscore in the head, or preceded by a dot)
const REF_RE = /(?<![\w.])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\.([A-Za-z_][\w-]*)/g;

/**
 * Places entities using what the source itself says: if an entity's
 * attributes (directly, or through intermediate resources such as an
 * `aws_db_subnet_group`) reference an entity whose kind the catalog lists as a
 * valid parent (`placement.parentKinds`), that is where it lives.
 *
 * Same repo only (an address is only meaningful inside its own repo).
 * Resolve-or-report, like everything else here: exactly one referenced
 * entity of the first referenced parent kind -> placement; several -> reported
 * in `unresolved`; none -> untouched (the catalog's kind-level placement, or
 * nothing, applies). Only entities without a parent are considered.
 *
 * @param {{
 *   entities: {id: string, kind: string, repoId: string, sourceAddress: string, parent: string|null}[],
 *   files: Record<string, {filePath: string, content: string}[]>,
 *   vars: Record<string, unknown>,
 *   catalog: {kinds: Record<string, object>},
 * }} input
 * @returns {{placements: {entityId: string, parent: string}[], unresolved: {entityId: string, parentKind: string, candidateCount: number}[]}}
 */
export function inferPlacementFromReferences({ entities, files, vars, catalog }) {
  const placements = [];
  const unresolved = [];

  for (const entity of entities) {
    if (entity.parent !== null || entity.embedded) continue;
    const parentKinds = specForKind(catalog?.kinds ?? {}, entity.kind).placement?.parentKinds;
    if (!parentKinds) continue;

    const repoFiles = files[entity.repoId];
    if (!repoFiles) continue;
    const byAddress = new Map(entities.filter((e) => e.repoId === entity.repoId).map((e) => [e.sourceAddress, e]));

    const hits = collectReferencedEntities(entity.sourceAddress, repoFiles, vars, byAddress);

    for (const [index, parentKind] of parentKinds.entries()) {
      const candidates = [...new Set(hits.filter((h) => h.kind === parentKind).map((h) => h.id))];
      if (candidates.length === 0) continue;
      if (candidates.length === 1) { placements.push({ entityId: entity.id, parent: candidates[0] }); break; }
      // several candidates (e.g. a cluster spanning subnets): if every candidate itself lives in one
      // and the same entity of a later parent kind, that shared parent is where the entity lives
      const shared = sharedParent(candidates, parentKinds.slice(index + 1), entities, repoFiles, vars, byAddress);
      if (shared) placements.push({ entityId: entity.id, parent: shared });
      else unresolved.push({ entityId: entity.id, parentKind, candidateCount: candidates.length });
      break;
    }
  }
  return { placements, unresolved };
}

/** The one entity of a later parent kind that every candidate references, or null. */
function sharedParent(candidateIds, laterKinds, entities, files, vars, byAddress) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const kind of laterKinds) {
    const perCandidate = candidateIds.map((id) => {
      const cand = byId.get(id);
      const hits = collectReferencedEntities(cand.sourceAddress, files, vars, byAddress);
      return new Set(hits.filter((h) => h.kind === kind).map((h) => h.id));
    });
    if (perCandidate.some((set) => set.size === 0)) continue;
    const common = [...perCandidate[0]].filter((id) => perCandidate.every((set) => set.has(id)));
    // every candidate must reference exactly that one parent (no candidate in two different ones)
    if (common.length === 1 && perCandidate.every((set) => set.size === 1)) return common[0];
    return null;
  }
  return null;
}

/** Breadth-first over references; stops at entities (they are the answer), walks through non-entity blocks. */
function collectReferencedEntities(startAddress, files, vars, byAddress) {
  const hits = [];
  const seen = new Set([startAddress]);
  let frontier = [startAddress];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const address of frontier) {
      for (const ref of referencesOf(address, files, vars)) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const entity = byAddress.get(ref);
        if (entity) hits.push(entity);
        else next.push(ref);
      }
    }
    frontier = next;
  }
  return hits;
}

export function referencesOf(address, files, vars) {
  const parsed = parseResourceAddress(address);
  if (!parsed) return [];
  const details = extractResourceDetails(files, { blockType: 'resource', labels: [parsed.type, parsed.name] }, vars);
  if (!details) return [];

  const refs = new Set();
  for (const result of Object.values(details.attributes)) {
    if (result.resolved) continue; // fully literal: no references inside
    for (const m of scanText(result.raw).matchAll(REF_RE)) refs.add(`${m[1]}.${m[2]}`);
  }
  return refs;
}

/** Drops string literals but keeps `${...}` interpolation bodies, where real references hide. */
function scanText(raw) {
  return raw.replace(/"((?:[^"\\]|\\.)*)"/g, (_, body) => [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join(' '));
}
