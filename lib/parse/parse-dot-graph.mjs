import { parseResourceAddress } from './parse-resource-address.mjs';

const NODE_LINE_RE = /^\s*"(.+?)"\s*\[label\s*=\s*"/;
const EDGE_LINE_RE = /^\s*"(.+?)"\s*->\s*"(.+?)"/;

/**
 * Parses raw `terraform graph -type=plan` DOT output (see
 * `lib/extract/terraform-graph.mjs`) into a normalized
 * `{ nodes, edges }` graph of resource/data-source addresses only.
 *
 * Non-resource DOT nodes (`provider[...]`, bare module boundary nodes,
 * `var.`/`local.`/`output.`/`meta.` references, and anything else
 * {@link parseResourceAddress} rejects) are silently dropped, along with
 * any edge touching one of them — this is the static dependency graph of
 * *resources*, not the full internal Terraform graph.
 *
 * An edge's endpoint is registered as a node even if the DOT text never
 * carried an explicit `[label = ...]` declaration line for it, so an edge
 * never silently drops a real resource endpoint.
 *
 * @param {string} dotText - raw DOT graph text.
 * @returns {{
 *   nodes: ReturnType<typeof parseResourceAddress>[],
 *   edges: { from: string, to: string }[],
 * }}
 */
export function parseDotGraph(dotText) {
  const nodesByAddress = new Map();
  const edges = [];

  for (const line of dotText.split('\n')) {
    const nodeMatch = NODE_LINE_RE.exec(line);
    if (nodeMatch) {
      registerNode(nodesByAddress, nodeMatch[1]);
      continue;
    }

    const edgeMatch = EDGE_LINE_RE.exec(line);
    if (edgeMatch) {
      const from = registerNode(nodesByAddress, edgeMatch[1]);
      const to = registerNode(nodesByAddress, edgeMatch[2]);
      if (from && to) {
        edges.push({ from: from.address, to: to.address });
      }
    }
  }

  return { nodes: [...nodesByAddress.values()], edges };
}

/**
 * Normalizes a raw DOT node id (`[root] <address> (expand)`) and, if it
 * resolves to a real resource/data-source address, registers it in the node
 * map (idempotent) and returns the parsed node. Returns `null` for anything
 * that isn't a resource address.
 */
function registerNode(nodesByAddress, rawId) {
  const address = normalizeDotNodeId(rawId);
  const parsed = parseResourceAddress(address);
  if (!parsed) return null;

  const existing = nodesByAddress.get(parsed.address);
  if (existing) return existing;

  nodesByAddress.set(parsed.address, parsed);
  return parsed;
}

/**
 * Strips the DOT-graph-specific decorations `terraform graph` adds around a
 * resource address: the `[root] ` module-root prefix and the trailing
 * `(expand)` / `(close)` expansion-state suffix.
 *
 * @param {string} rawId
 * @returns {string}
 */
export function normalizeDotNodeId(rawId) {
  return rawId
    .replace(/^\[root\]\s*/, '')
    .replace(/\s*\((?:expand|close)\)\s*$/, '')
    .trim();
}
