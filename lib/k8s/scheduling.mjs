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
 * @param {{name: string, labels: Record<string,string>, requirements: {key:string, operator:string, values?:string[]}[], taints: {key:string, value?:string, effect:string}[]}[]} pools
 */
export function candidatePools(podSpec, pools) {
  const constraints = [];
  for (const [key, value] of Object.entries(podSpec?.nodeSelector ?? {})) constraints.push({ key, operator: 'In', values: [String(value)] });

  const required = podSpec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (required) {
    const terms = required.nodeSelectorTerms ?? [];
    if (terms.length > 1) return unknown();
    for (const term of terms) {
      if ((term.matchFields ?? []).length) return unknown();
      for (const expr of term.matchExpressions ?? []) {
        if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(expr.operator)) return unknown();
        constraints.push({ key: expr.key, operator: expr.operator, values: (expr.values ?? []).map(String) });
      }
    }
  }

  const tolerations = podSpec?.tolerations ?? [];
  const candidates = pools.filter((pool) =>
    constraints.every((c) => satisfies(pool, c)) &&
    pool.taints.filter((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute').every((t) => tolerations.some((tol) => tolerates(tol, t))));

  const status = candidates.length === 1 ? 'resolved' : candidates.length === 0 ? 'none' : 'ambiguous';
  return { status, candidates };
}

const unknown = () => ({ status: 'unknown', candidates: [] });

// Labels Karpenter can satisfy on its own when the NodePool does not constrain them.
const WELL_KNOWN = new Set([
  'kubernetes.io/arch', 'kubernetes.io/os', 'topology.kubernetes.io/zone', 'topology.kubernetes.io/region',
  'node.kubernetes.io/instance-type', 'karpenter.sh/capacity-type',
]);
const isWellKnown = (key) => WELL_KNOWN.has(key) || key.startsWith('karpenter.k8s.aws/');

function satisfies(pool, { key, operator, values }) {
  const label = pool.labels[key];
  const req = pool.requirements.find((r) => r.key === key);
  const reqValues = req && req.operator === 'In' ? req.values ?? [] : null;
  const known = isWellKnown(key);

  switch (operator) {
    case 'In':
      if (label !== undefined) return values.includes(label);
      if (reqValues) return reqValues.some((v) => values.includes(v));
      if (req && (req.operator === 'Exists')) return true;
      return known && !req;
    case 'NotIn':
      if (label !== undefined) return !values.includes(label);
      if (reqValues) return reqValues.some((v) => !values.includes(v));
      return true;
    case 'Exists':
      return label !== undefined || Boolean(req && req.operator !== 'DoesNotExist') || (known && !req);
    case 'DoesNotExist':
      return label === undefined && !(req && req.operator !== 'DoesNotExist');
    default:
      return false;
  }
}

function tolerates(tol, taint) {
  if (tol.effect && tol.effect !== taint.effect) return false;
  if (tol.operator === 'Exists') return !tol.key || tol.key === taint.key;
  return tol.key === taint.key && (tol.value ?? '') === (taint.value ?? '');
}
