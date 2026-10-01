/**
 * Applies a Layer B manifest's rules to a single parsed node (see
 * `lib/parse/parse-dot-graph.mjs`) and returns the friendly entity it maps
 * to, or `null` if no rule matches.
 *
 * Rules are evaluated in array order; the first matching rule wins (later
 * rules for the same resource type are intentionally unreachable — this is
 * how a manifest author overrides a general rule with a more specific one
 * placed earlier).
 *
 * @param {{address: string, modulePath: string[], isData: boolean, type: string, name: string, index: number|string|null}} node
 * @param {{repoId: string, rules: Array<{match: object, entity: object}>}} manifest
 * @returns {{kind: string, id: string, boundary: string|null, embed: boolean, sourceAddress: string} | null}
 */
export function matchEntity(node, manifest) {
  for (const rule of manifest.rules) {
    if (ruleMatches(rule.match, node)) {
      return buildEntity(rule.entity, node);
    }
  }
  return null;
}

function ruleMatches(match, node) {
  if (match.type !== undefined && !typeMatches(match.type, node.type)) {
    return false;
  }
  if (match.isData !== undefined && match.isData !== node.isData) {
    return false;
  }
  if (match.modulePathPrefix !== undefined && !modulePathHasPrefix(node.modulePath, match.modulePathPrefix)) {
    return false;
  }
  if (match.nameRegex !== undefined && !new RegExp(match.nameRegex).test(node.name)) {
    return false;
  }
  return true;
}

function typeMatches(matchType, nodeType) {
  if (Array.isArray(matchType)) {
    return matchType.includes(nodeType);
  }
  return matchType === nodeType;
}

function modulePathHasPrefix(modulePath, prefix) {
  if (prefix.length > modulePath.length) return false;
  return prefix.every((segment, i) => modulePath[i] === segment);
}

function buildEntity(entityRule, node) {
  return {
    kind: entityRule.kind,
    id: resolveId(entityRule, node),
    boundary: entityRule.boundary ?? null,
    embed: entityRule.embed === true,
    sourceAddress: node.address,
  };
}

function resolveId(entityRule, node) {
  switch (entityRule.idFrom) {
    case 'name':
      return node.name;
    case 'address':
      return node.address;
    case 'literal':
      return entityRule.id;
    default:
      throw new Error(`manifest rule for kind "${entityRule.kind}" has unknown idFrom: "${entityRule.idFrom}"`);
  }
}
