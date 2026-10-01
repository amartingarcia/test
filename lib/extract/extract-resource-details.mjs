import { findResourceBlock } from './find-resource-block.mjs';
import { parseHclAttributes, parseHclNestedBlocks } from '../parse/parse-hcl-attributes.mjs';
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

  const rawAttrs = flattenBody(found.block.body, '', 0);
  const keys = options.detailFields ?? Object.keys(rawAttrs);

  const attributes = {};
  for (const key of keys) {
    if (!(key in rawAttrs)) continue;
    attributes[key] = resolveHclValue(rawAttrs[key], vars);
  }

  return { filePath: found.filePath, attributes };
}

// lifecycle/provisioner/connection configure Terraform's behaviour, not the resource
const META_BLOCKS = new Set(['lifecycle', 'provisioner', 'connection']);
const MAX_BLOCK_DEPTH = 4;

/**
 * Attributes of a body plus those of its nested blocks, flattened into
 * dotted keys: `vpc_config.subnet_ids`, `ingress[1].from_port` (repeated
 * blocks are indexed), `rule.r1.k` (labels are part of the path).
 */
function flattenBody(body, prefix, depth) {
  const out = {};
  for (const [key, raw] of Object.entries(parseHclAttributes(body))) out[prefix + key] = raw;
  if (depth >= MAX_BLOCK_DEPTH) return out;

  const blocks = parseHclNestedBlocks(body).filter((b) => !META_BLOCKS.has(b.type));
  const totals = new Map();
  for (const b of blocks) totals.set(b.type, (totals.get(b.type) ?? 0) + 1);
  const seen = new Map();

  for (const b of blocks) {
    const n = seen.get(b.type) ?? 0;
    seen.set(b.type, n + 1);
    const head = totals.get(b.type) > 1 && b.labels.length === 0 ? `${b.type}[${n}]` : [b.type, ...b.labels].join('.');
    Object.assign(out, flattenBody(b.body, `${prefix}${head}.`, depth + 1));
  }
  return out;
}

const META_ARGUMENTS = new Set(['count', 'for_each', 'depends_on', 'provider']);

/** The attributes worth showing for an entity: Terraform meta-arguments are not properties of the resource. */
export function entityDetails(attributes) {
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([key]) => !META_ARGUMENTS.has(key)));
}
