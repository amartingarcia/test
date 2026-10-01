import { validateManifest } from './validate-manifest.mjs';
import { findSpec } from '../catalog/spec-for-kind.mjs';

/**
 * Checks a manifest beyond its shape (see `validateManifest`) — the mistakes
 * that still produce a diagram, just a wrong or generic one. Findings are
 * `{ level: 'error' | 'warn', rule?: number, message }`; errors mean the
 * manifest cannot be used, warnings mean "look at this before trusting the
 * output". Written so an author (human or model) can fix everything from the
 * message alone.
 */
export function lintManifest(manifest, catalog) {
  const findings = validateManifest(manifest).map((message) => ({ level: 'error', message }));
  if (findings.length) return findings;

  const producedKinds = new Set(manifest.rules.filter((r) => r.entity).map((r) => r.entity.kind));
  const seenMatches = new Map();

  manifest.rules.forEach((rule, i) => {
    const key = JSON.stringify(rule.match);
    if (seenMatches.has(key)) {
      findings.push({
        level: 'warn', rule: i,
        message: `rules[${i}] never matches: rules[${seenMatches.get(key)}] has the identical \`match\` and rules are first-match-wins. Delete it, or make the earlier rule more specific.`,
      });
    } else {
      seenMatches.set(key, i);
    }
    if (!rule.entity) return;

    const { kind, boundary } = rule.entity;
    if (!findSpec(catalog?.kinds ?? {}, kind)) {
      findings.push({
        level: 'warn', rule: i,
        message: `kind "${kind}" has no catalog entry (exact or by dotted prefix): it will be drawn as a generic box with no icon, order or placement rule. Add it to catalog/providers/<provider>.json.`,
      });
    }
    if (boundary && !producedKinds.has(boundary)) {
      findings.push({
        level: 'warn', rule: i,
        message: `boundary "${boundary}" is not produced by any rule in this manifest; it only resolves if another entity of that kind exists in the same repo. For a parent in another repo, use a crossRepoLink with \`nest: true\` or rely on the catalog placement.`,
      });
    }
  });
  return findings;
}

const AXES = new Set(['row', 'column']);

/** Consistency of the catalog itself. */
export function lintCatalog(catalog) {
  const findings = [];
  const kinds = catalog.kinds ?? {};
  const known = (kind) => findSpec(kinds, kind) !== undefined || Object.keys(kinds).some((k) => k.startsWith(`${kind}.`));

  for (const [kind, spec] of Object.entries(kinds)) {
    for (const parent of spec.placement?.parentKinds ?? []) {
      if (!known(parent)) {
        findings.push({ level: 'warn', message: `catalog kind "${kind}" lists placement parent "${parent}", which the catalog does not know. Add "${parent}" or fix the name.` });
      }
    }
    if (spec.order !== undefined && typeof spec.order !== 'number') {
      findings.push({ level: 'error', message: `catalog kind "${kind}": order must be a number (lower = further left / higher).` });
    }
    if (spec.axis !== undefined && !AXES.has(spec.axis)) {
      findings.push({ level: 'error', message: `catalog kind "${kind}": axis must be "row" or "column", got "${spec.axis}".` });
    }
  }
  return findings;
}
