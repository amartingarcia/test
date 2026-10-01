import { findResourceBlock } from './find-resource-block.mjs';
import { parseHclAttributes } from '../parse/parse-hcl-attributes.mjs';
import { resolveHclValue } from '../parse/resolve-hcl-value.mjs';

/**
 * Layer A2 entrypoint: finds a resource/module block across a set of `.tf`
 * files, extracts its attributes, and resolves each one against `vars`
 * (see `parseTfvars`). Each attribute comes back as either
 * `{ resolved: true, value }` or `{ resolved: false, raw }` — never
 * silently coerced or guessed (see `resolveHclValue`).
 *
 * @param {{ filePath: string, content: string }[]} files
 * @param {{ blockType: string, labels: string[] }} target
 * @param {Record<string, unknown>} vars - resolved values, e.g. from parseTfvars.
 * @param {{ detailFields?: string[] }} [options] - when `detailFields` is
 *   given, only those attribute keys are returned (missing ones are simply
 *   absent from the result, not reported as an error — a manifest author
 *   asking for a field a given resource doesn't declare is not a failure).
 * @returns {{ filePath: string, attributes: Record<string, { resolved: true, value: unknown } | { resolved: false, raw: string }> } | null}
 */
export function extractResourceDetails(files, target, vars, options = {}) {
  const found = findResourceBlock(files, target);
  if (!found) return null;

  const rawAttrs = parseHclAttributes(found.block.body);
  const keys = options.detailFields ?? Object.keys(rawAttrs);

  const attributes = {};
  for (const key of keys) {
    if (!(key in rawAttrs)) continue;
    attributes[key] = resolveHclValue(rawAttrs[key], vars);
  }

  return { filePath: found.filePath, attributes };
}
