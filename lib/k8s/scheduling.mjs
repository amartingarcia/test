/**
 * Static scheduling resolution: which node pools (Karpenter NodePools or
 * node groups) could host a pod spec, from nodeSelector, required node
 * affinity and taints/tolerations only. Pure and conservative:
 *   resolved  - exactly one pool qualifies
 *   ambiguous - several qualify (never picked arbitrarily)
 *   none      - no pool qualifies
 *   unknown   - the spec uses constructs we do not evaluate (Gt/Lt, OR-ed terms)
 *
 * @param {object} podSpec
 * @param {{name: string, labels: Record<string,string>, requirements: {key:string, operator:string, values?:string[]}[], taints: {key:string, value?:string, effect:string}[], uncertain?: boolean, static?: boolean}[]} pools
 */
export function candidatePools(podSpec, pools) {
  const base = [];
  for (const [key, value] of Object.entries(podSpec?.nodeSelector ?? {})) base.push({ key, operator: 'In', values: [String(value)] });

  // required node affinity: terms are OR-ed, expressions inside a term are AND-ed.
  // A null/empty term matches no node (Kubernetes semantics).
  const alternatives = []; // each: constraints that must all hold
  const required = podSpec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (required) {
    for (const term of required.nodeSelectorTerms ?? []) {
      if ((term.matchFields ?? []).length) return unknown();
      const exprs = term.matchExpressions ?? [];
      if (!exprs.length) continue;
      const cs = [];
      for (const expr of exprs) {
        if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(expr.operator)) return unknown();
        cs.push({ key: expr.key, operator: expr.operator, values: (expr.values ?? []).map(String) });
      }
      alternatives.push(cs);
    }
    if (!alternatives.length) return { status: 'none', candidates: [] };
  }
  if (!alternatives.length) alternatives.push([]);

  const tolerations = podSpec?.tolerations ?? [];
  const allKeys = new Set([...base, ...alternatives.flat()].map((c) => c.key));
  // a pool whose labels/taints could not be resolved, or whose requirements use operators we
  // cannot decide (Gt/Lt/...), cannot be ruled out, nor ruled in
  const isUncertain = (pool) => pool.uncertain || pool.requirements.some((r) => allKeys.has(r.key) && !DECIDABLE.has(r.operator));
  const tolerated = (pool) => pool.taints.filter((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute').every((t) => tolerations.some((tol) => tolerates(tol, t)));
  const candidates = pools.filter((pool) => isUncertain(pool) || (
    tolerated(pool) && alternatives.some((alt) => [...base, ...alt].every((c) => satisfies(pool, c)))));

  if (candidates.some(isUncertain)) return { status: candidates.length === 1 ? 'unknown' : 'ambiguous', candidates };
  const status = candidates.length === 1 ? 'resolved' : candidates.length === 0 ? 'none' : 'ambiguous';
  return { status, candidates };
}

const DECIDABLE = new Set(['In', 'Exists', 'DoesNotExist']);
const unknown = () => ({ status: 'unknown', candidates: [] });

// Labels Karpenter can satisfy on its own when the NodePool does not constrain them.
const WELL_KNOWN = new Set([
  'kubernetes.io/arch', 'kubernetes.io/os', 'topology.kubernetes.io/zone', 'topology.kubernetes.io/region',
  'node.kubernetes.io/instance-type', 'karpenter.sh/capacity-type',
]);
const isWellKnown = (key) => WELL_KNOWN.has(key) || key.startsWith('karpenter.k8s.aws/');

function satisfies(pool, { key, operator, values }) {
  const label = pool.labels[key];
  const reqs = pool.requirements.filter((r) => r.key === key);
  // Karpenter-only labels never exist on nodes of a static (managed) node group
  const known = isWellKnown(key) && !(pool.static && key.startsWith('karpenter.'));
  // values a node of this pool may carry for `key`: intersection of every `In` requirement
  const ins = reqs.filter((r) => r.operator === 'In');
  const allowed = ins.length ? ins.map((r) => r.values ?? []).reduce((acc, v) => acc.filter((x) => v.includes(x))) : null;
  const exists = label !== undefined || reqs.some((r) => r.operator === 'In' || r.operator === 'Exists') || known;
  const forbidden = reqs.some((r) => r.operator === 'DoesNotExist') && label === undefined;

  switch (operator) {
    case 'In':
      if (label !== undefined) return values.includes(label);
      if (allowed) return allowed.some((v) => values.includes(v));
      if (reqs.some((r) => r.operator === 'Exists')) return true;
      return known && !forbidden;
    case 'NotIn':
      if (label !== undefined) return !values.includes(label);
      if (allowed) return allowed.some((v) => !values.includes(v));
      return true;
    case 'Exists':
      return exists && !forbidden;
    case 'DoesNotExist':
      return !exists;
    default:
      return false;
  }
}

function tolerates(tol, taint) {
  if (tol.effect && tol.effect !== taint.effect) return false;
  if (tol.operator === 'Exists') return !tol.key || tol.key === taint.key;
  return tol.key === taint.key && (tol.value ?? '') === (taint.value ?? '');
}
