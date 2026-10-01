const VALID_ID_FROM = new Set(['name', 'address', 'literal']);
const MATCH_KEYS = ['type', 'isData', 'modulePathPrefix', 'nameRegex'];

/**
 * Structurally validates a Layer B manifest object against the shape
 * `schemas/manifest.schema.json` documents, without a JSON Schema
 * dependency (this project stays zero-dependency, same as Layer A).
 *
 * Returns an array of human-readable error strings — empty when the
 * manifest is valid. Collects every error found rather than stopping at
 * the first, so an author can fix a manifest in one pass.
 *
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function validateManifest(manifest) {
  const errors = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return ['manifest must be an object'];
  }

  if (typeof manifest.repoId !== 'string' || manifest.repoId.length === 0) {
    errors.push('manifest.repoId must be a non-empty string');
  }

  if (!Array.isArray(manifest.rules)) {
    errors.push('manifest.rules must be an array');
    return errors;
  }

  manifest.rules.forEach((rule, i) => {
    errors.push(...validateRule(rule, i));
  });

  return errors;
}

function validateRule(rule, i) {
  const errors = [];
  const prefix = `rules[${i}]`;

  if (typeof rule !== 'object' || rule === null) {
    return [`${prefix} must be an object`];
  }

  errors.push(...validateMatch(rule.match, prefix));
  errors.push(...validateEntity(rule.entity, prefix));

  return errors;
}

function validateMatch(match, prefix) {
  const errors = [];
  const path = `${prefix}.match`;

  if (typeof match !== 'object' || match === null) {
    return [`${path} must be an object`];
  }

  const presentKeys = MATCH_KEYS.filter((key) => match[key] !== undefined);
  if (presentKeys.length === 0) {
    errors.push(`${path} must set at least one of: ${MATCH_KEYS.join(', ')}`);
  }

  if (match.modulePathPrefix !== undefined && !Array.isArray(match.modulePathPrefix)) {
    errors.push(`${path}.modulePathPrefix must be an array of strings`);
  }

  return errors;
}

function validateEntity(entity, prefix) {
  const errors = [];
  const path = `${prefix}.entity`;

  if (typeof entity !== 'object' || entity === null) {
    return [`${path} must be an object`];
  }

  if (typeof entity.kind !== 'string' || entity.kind.length === 0) {
    errors.push(`${path}.kind must be a non-empty string`);
  }

  if (!VALID_ID_FROM.has(entity.idFrom)) {
    errors.push(`${path}.idFrom must be one of: ${[...VALID_ID_FROM].join(', ')}`);
  } else if (entity.idFrom === 'literal' && (typeof entity.id !== 'string' || entity.id.length === 0)) {
    errors.push(`${path}.id must be a non-empty string when idFrom is "literal"`);
  }

  return errors;
}
