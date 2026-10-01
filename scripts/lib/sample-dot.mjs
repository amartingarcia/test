// Sample-only helper: the DOT a `terraform graph` would give, derived from the
// references between resources of SYNTHETIC .tf files. Real runs use
// `terraform graph` (lib/extract) instead.

import { parseHclBlocks } from '../../lib/parse/parse-hcl-blocks.mjs';
import { parseResourceAddress } from '../../lib/parse/parse-resource-address.mjs';
import { referencesOf } from '../../lib/compile/infer-placement.mjs';
import { extractResourceDetails } from '../../lib/extract/extract-resource-details.mjs';

/**
 * The DOT a `terraform graph` would give for one environment: one node per
 * instantiated resource, an edge per reference between resources. A resource
 * whose `count` resolves to 0 under the environment's tfvars is not
 * instantiated, so it (and its edges) simply is not there.
 */
export function dotFromTerraform(files, vars) {
  const all = [];
  for (const f of files) {
    for (const b of parseHclBlocks(f.content)) {
      if (b.blockType === 'resource' && b.labels.length === 2) all.push(`${b.labels[0]}.${b.labels[1]}`);
    }
  }
  const addresses = all.filter((a) => {
    const p = parseResourceAddress(a);
    const d = extractResourceDetails(files, { blockType: 'resource', labels: [p.type, p.name] }, vars);
    return !(d?.attributes.count?.resolved && d.attributes.count.value === 0);
  });
  const known = new Set(addresses);
  const q = (a) => `"[root] ${a} (expand)"`;
  const lines = addresses.map((a) => `\t\t${q(a)} [label = "${a}", shape = "box"]`);
  for (const a of addresses) {
    for (const ref of referencesOf(a, files, vars)) if (known.has(ref)) lines.push(`\t\t${q(a)} -> ${q(ref)}`);
  }
  return `digraph {\n\tsubgraph "root" {\n${lines.join('\n')}\n\t}\n}\n`;
}

