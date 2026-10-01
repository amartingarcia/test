import { matchEntity } from '../manifest/match-entity.mjs';
import { specForKind } from '../catalog/spec-for-kind.mjs';

/**
 * Layer C entrypoint: merges N repos' extracted+parsed graphs (Layer A/A2
 * output, run through each repo's own Layer B manifest) into one compound
 * graph for a single environment.
 *
 * Every id/resolution decision here follows the same rule the rest of this
 * project holds to: resolve unambiguously or report, never guess.
 * - A node with no matching manifest rule is **unmapped**: dropped from
 *   `entities`/`edges`, listed in `coverage[repoId].unmapped`.
 * - An edge where either endpoint is unmapped is dropped (its structural
 *   neighbor doesn't exist as an entity); not separately counted — it's
 *   implied by the unmapped node already being listed.
 * - An entity's `boundary` (its parent's exact `kind`, see
 *   `schemas/manifest.schema.json`) resolves to `parent` only when exactly
 *   one entity of that kind exists in the **same repo**. Zero or multiple
 *   candidates leaves `parent: null` and is reported in
 *   `coverage[repoId].unresolvedBoundaries`.
 * - A declarative `crossRepoLinks` rule (`{fromKind, toKind, label}`) wires
 *   an edge only when exactly one entity of `fromKind` and exactly one of
 *   `toKind` exist across ALL repos combined. Otherwise it's reported in
 *   `unresolvedCrossRepoLinks`, not guessed.
 *
 * @param {object} options
 * @param {string} options.environment
 * @param {{repoId: string, manifest: object, nodes: object[], edges: {from: string, to: string}[]}[]} options.repoGraphs
 * @param {{fromKind: string, toKind: string, label?: string, nest?: boolean}[]} [options.crossRepoLinks]
 * @param {{fromKind: string, toKind: string, label: string}[]} [options.edgeLabels]
 * @returns {{
 *   environment: string,
 *   entities: {id: string, kind: string, parent: string|null, repoId: string, sourceAddress: string}[],
 *   edges: {from: string, to: string, label?: string}[],
 *   coverage: Record<string, {unmapped: string[], unresolvedBoundaries: {entityId: string, boundary: string, candidateCount: number}[]}>,
 *   unresolvedCrossRepoLinks: {fromKind: string, toKind: string, fromCount: number, toCount: number}[],
 * }}
 */
export function compileEnvironmentGraph({ environment, repoGraphs, crossRepoLinks = [], edgeLabels = [], catalog = null }) {
  const coverage = {};
  const entities = [];
  const edges = [];
  // per-repo map: original node address -> compiled entity, for edge translation
  const addressToEntity = new Map();

  for (const repoGraph of repoGraphs) {
    const { repoId, manifest, nodes, edges: rawEdges } = repoGraph;
    const unmapped = [];
    const repoEntities = [];

    for (const node of nodes) {
      const matched = matchEntity(node, manifest);
      if (!matched) {
        unmapped.push(node.address);
        continue;
      }
      const compiled = {
        id: compileId(repoId, matched.kind, matched.id),
        kind: matched.kind,
        repoId,
        sourceAddress: matched.sourceAddress,
        boundary: matched.boundary,
        embed: matched.embed,
        parent: null, // resolved below, once all this repo's entities are known
      };
      repoEntities.push(compiled);
      addressToEntity.set(scopedAddress(repoId, node.address), compiled);
    }

    const unresolvedBoundaries = resolveBoundaries(repoEntities);

    for (const entity of repoEntities) {
      delete entity.boundary; // internal-only; public shape is {parent}
      if (entity.embed) entity.embedded = true;
      delete entity.embed;
      entities.push(entity);
    }

    coverage[repoId] = { unmapped, unresolvedBoundaries };

    for (const rawEdge of rawEdges) {
      const from = addressToEntity.get(scopedAddress(repoId, rawEdge.from));
      const to = addressToEntity.get(scopedAddress(repoId, rawEdge.to));
      if (from && to) {
        edges.push({ from: from.id, to: to.id });
      }
    }
  }

  const unresolvedCrossRepoLinks = [];
  for (const link of crossRepoLinks) {
    const fromMatches = entities.filter((e) => e.kind === link.fromKind);
    const toMatches = entities.filter((e) => e.kind === link.toKind);
    const counts = { fromKind: link.fromKind, toKind: link.toKind, fromCount: fromMatches.length, toCount: toMatches.length };

    if (link.nest) {
      // containment across repos: any number of `from` entities, but exactly
      // one possible container — otherwise it would be a guess
      if (fromMatches.length === 0 || toMatches.length !== 1) {
        unresolvedCrossRepoLinks.push(counts);
      } else if (fromMatches.some((e) => e.parent !== null)) {
        unresolvedCrossRepoLinks.push({ ...counts, reason: 'already-nested' });
      } else {
        for (const e of fromMatches) e.parent = toMatches[0].id;
      }
    } else if (fromMatches.length === 1 && toMatches.length === 1) {
      edges.push({ from: fromMatches[0].id, to: toMatches[0].id, label: link.label });
    } else {
      unresolvedCrossRepoLinks.push(counts);
    }
  }

  // The "architect": where does each kind of thing live? The catalog
  // (catalog/kinds.json) knows, per kind, which kinds it may be placed in, in
  // preference order. Applied last, and only to entities still without a
  // parent, so explicit boundaries and nest links always win.
  const unresolvedPlacements = placeByCatalog(entities, catalog);

  // Name relationships by what they mean (assumes / stores data in / ...),
  // keyed on endpoint kinds. Never overrides a label that is already set.
  const kindById = new Map(entities.map((e) => [e.id, e.kind]));
  for (const edge of edges) {
    if (edge.label !== undefined) continue;
    const rule = edgeLabels.find((l) => l.fromKind === kindById.get(edge.from) && l.toKind === kindById.get(edge.to));
    if (rule) edge.label = rule.label;
  }

  return { environment, entities, edges, coverage, unresolvedCrossRepoLinks, unresolvedPlacements };
}

function compileId(repoId, kind, id) {
  return `${repoId}:${kind}:${id}`;
}

function scopedAddress(repoId, address) {
  return `${repoId}\u0000${address}`;
}

/**
 * Resolves each entity's `boundary` (a target kind) to `parent` (a
 * compiled entity id) within one repo's entity list, mutating `parent` in
 * place. Returns the list of boundaries that could not be resolved.
 */
function resolveBoundaries(repoEntities) {
  const unresolved = [];

  for (const entity of repoEntities) {
    if (!entity.boundary) continue;

    const candidates = repoEntities.filter((e) => e.kind === entity.boundary);
    if (candidates.length === 1) {
      entity.parent = candidates[0].id;
    } else {
      unresolved.push({ entityId: entity.id, boundary: entity.boundary, candidateCount: candidates.length });
    }
  }

  return unresolved;
}

/**
 * For each parentless, non-embedded entity whose kind has
 * `placement.parentKinds`, picks the first listed kind that has any
 * candidate; nests only when that kind has exactly one. Several candidates
 * are reported, never guessed (a later step can narrow them using resolved
 * attributes such as `subnet_ids`).
 */
function placeByCatalog(entities, catalog) {
  const unresolved = [];
  if (!catalog?.kinds) return unresolved;

  for (const entity of entities) {
    if (entity.parent !== null || entity.embedded) continue;
    const parentKinds = specForKind(catalog.kinds, entity.kind).placement?.parentKinds;
    if (!parentKinds) continue;

    for (const parentKind of parentKinds) {
      const candidates = entities.filter((e) => e.kind === parentKind && e.id !== entity.id);
      if (candidates.length === 0) continue;
      if (candidates.length === 1) entity.parent = candidates[0].id;
      else unresolved.push({ entityId: entity.id, parentKind, candidateCount: candidates.length });
      break;
    }
  }
  return unresolved;
}
