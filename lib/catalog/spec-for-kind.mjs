/**
 * Looks up a kind's catalog entry. Exact match first, then the longest
 * dotted prefix (`aws.iam.role.node` -> `aws.iam.role` -> `aws.iam`), so a
 * family of kinds can share one entry. Unknown kinds get `{}`, never an error.
 */
export function specForKind(kinds, kind) {
  const parts = kind.split('.');
  for (let n = parts.length; n > 0; n--) {
    const spec = kinds[parts.slice(0, n).join('.')];
    if (spec) return spec;
  }
  return {};
}
