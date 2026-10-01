import { matchEntity } from '../manifest/match-entity.mjs';

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
 * @param {{fromKind: string, toKind: string, label?: string}[]} [options.crossRepoLinks]
 * @returns {{
 *   environment: string,
 *   entities: {id: string, kind: string, parent: string|null, repoId: string, sourceAddress: string}[],
 *   edges: {from: string, to: string, label?: string}[],
 *   coverage: Record<string, {unmapped: string[], unresolvedBoundaries: {entityId: string, boundary: string, candidateCount: number}[]}>,
 *   unresolvedCrossRepoLinks: {fromKind: string, toKind: string, fromCount: number, toCount: number}[],
 * }}
 */
export function compileEnvironmentGraph({ environment, repoGraphs, crossRepoLinks = [] }) {
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
        parent: null, // resolved below, once all this repo's entities are known
      };
      repoEntities.push(compiled);
      addressToEntity.set(scopedAddress(repoId, node.address), compiled);
    }

    const unresolvedBoundaries = resolveBoundaries(repoEntities);

    for (const entity of repoEntities) {
      delete entity.boundary; // internal-only; public shape is {parent}
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
    if (fromMatches.length === 1 && toMatches.length === 1) {
      edges.push({ from: fromMatches[0].id, to: toMatches[0].id, label: link.label });
    } else {
      unresolvedCrossRepoLinks.push({
        fromKind: link.fromKind,
        toKind: link.toKind,
        fromCount: fromMatches.length,
        toCount: toMatches.length,
      });
    }
  }

  return { environment, entities, edges, coverage, unresolvedCrossRepoLinks };
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
