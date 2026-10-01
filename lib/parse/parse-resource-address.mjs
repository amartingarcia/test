const MODULE_SEGMENT_RE = /^module\.([a-zA-Z_][a-zA-Z0-9_-]*)\./;
const RESOURCE_TAIL_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_-]*)(\[[^\]]*\])?$/;

/**
 * Terraform expression-language keywords that can appear as the first
 * segment of a DOT graph node id but are never a resource/data-source
 * type: `var.x`, `local.x`, `output.x` (root module outputs), bare
 * `module.x` boundary nodes (no trailing resource), and internal
 * `meta.`/`each.`/`count.`/`path.`/`terraform.`/`self.` references.
 */
const RESERVED_HEAD_SEGMENTS = new Set([
  'var',
  'local',
  'output',
  'module',
  'meta',
  'each',
  'count',
  'path',
  'terraform',
  'self',
]);

/**
 * Parses a single Terraform resource/data-source address (already stripped
 * of DOT-graph decorations like `[root] ` / ` (expand)` — see
 * {@link normalizeDotNodeId}) into its structural parts.
 *
 * Returns `null` for anything that is not a resource/data-source address:
 * provider nodes (`provider["..."]`), bare module-call boundary nodes
 * (`module.network` with no trailing resource), and `var.`/`local.`/
 * `output.`/`meta.` reference nodes that `terraform graph` also emits.
 *
 * @param {string} address
 * @returns {{
 *   address: string,
 *   modulePath: string[],
 *   isData: boolean,
 *   type: string,
 *   name: string,
 *   index: number|string|null,
 * } | null}
 */
export function parseResourceAddress(address) {
  const originalAddress = address;
  let remaining = address;
  const modulePath = [];

  let moduleMatch;
  // eslint-disable-next-line no-cond-assign
  while ((moduleMatch = MODULE_SEGMENT_RE.exec(remaining))) {
    modulePath.push(moduleMatch[1]);
    remaining = remaining.slice(moduleMatch[0].length);
  }

  const isData = remaining.startsWith('data.');
  if (isData) {
    remaining = remaining.slice('data.'.length);
  }

  const tailMatch = RESOURCE_TAIL_RE.exec(remaining);
  if (!tailMatch) {
    return null;
  }

  const [, type, name, indexRaw] = tailMatch;

  if (RESERVED_HEAD_SEGMENTS.has(type)) {
    return null;
  }
  const index = parseIndex(indexRaw);

  return {
    address: originalAddress,
    modulePath,
    isData,
    type,
    name,
    index,
  };
}

function parseIndex(indexRaw) {
  if (!indexRaw) return null;
  const inner = indexRaw.slice(1, -1); // strip surrounding [ ]
  if (/^-?\d+$/.test(inner)) {
    return Number(inner);
  }
  const quoted = inner.match(/^"(.*)"$/);
  return quoted ? quoted[1] : inner;
}
