import { parseHclAttributes } from './parse-hcl-attributes.mjs';
import { resolveHclValue } from './resolve-hcl-value.mjs';

/**
 * Parses a `.tfvars` file's content into a flat `{ [name]: value }` map of
 * already-resolved JS values, for use as the `vars` argument to
 * `resolveHclValue` when resolving a `.tf` file's `var.NAME` references.
 *
 * `.tfvars` syntax is top-level `key = value` assignments — the same shape
 * `parseHclAttributes` already extracts — so this just runs that, then
 * resolves each raw value as a literal (tfvars entries are always literals,
 * never `var.`/`local.` references — there is nothing to resolve them
 * against here). A value that cannot be resolved as a scalar literal (a
 * list or map, e.g. `azs = ["eu-west-1a", "eu-west-1b"]`) is **omitted**
 * from the result rather than guessed — callers resolving a `var.azs`
 * reference against this map correctly see it as still-unresolved.
 *
 * @param {string} tfvarsContent
 * @returns {Record<string, unknown>}
 */
export function parseTfvars(tfvarsContent) {
  const rawAttrs = parseHclAttributes(tfvarsContent);
  const resolved = {};

  for (const [name, rawValue] of Object.entries(rawAttrs)) {
    const result = resolveHclValue(rawValue, {});
    if (result.resolved) {
      resolved[name] = result.value;
    }
  }

  return resolved;
}
