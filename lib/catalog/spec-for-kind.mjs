/**
 * Looks up a kind's catalog entry. Exact match first, then the longest
 * dotted prefix (`aws.iam.role.node` -> `aws.iam.role` -> `aws.iam`), so a
 * family of kinds can share one entry. `undefined` when the kind is unknown
 * (an entry may legitimately be an empty object, so callers that need to
 * tell "unknown" from "known but bare" use this).
 */
export function findSpec(kinds, kind) {
  const parts = kind.split('.');
  for (let n = parts.length; n > 0; n--) {
    const spec = kinds[parts.slice(0, n).join('.')];
    if (spec) return spec;
  }
  return undefined;
}

/** Same lookup, but unknown kinds get `{}`, never an error. */
export function specForKind(kinds, kind) {
  return findSpec(kinds, kind) ?? {};
}
