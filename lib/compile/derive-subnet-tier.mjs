import { parseHclBlocks } from '../parse/parse-hcl-blocks.mjs';
import { extractResourceDetails } from '../extract/extract-resource-details.mjs';

/**
 * Public / private / isolated subnet tier, derived from what AWS itself defines:
 * a subnet is public when its route table has a default route to an internet gateway
 * (https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html). Nothing here
 * looks at names.
 *
 *   default route (0.0.0.0/0) -> aws_internet_gateway : public
 *   default route (0.0.0.0/0) -> aws_nat_gateway      : private (egress only)
 *   no default route                                  : isolated
 *
 * Resolve-or-report: a subnet is NOT classified (tier null + reason) when the evidence is
 * incomplete: no explicit `aws_route_table_association` (the VPC main route table applies and
 * is not evaluated), dynamic or unresolved routes, an unresolved destination, a non-default
 * route to an internet gateway, an IPv6-only internet route, or a default route through
 * anything else (transit gateway, ENI, ...).
 *
 * @param {{files: {filePath: string, content: string}[], vars: Record<string, unknown>}} input one repo's .tf files
 * @returns {Map<string, {tier: 'public'|'private'|'isolated'|null, reason: string}>} keyed by `aws_subnet.<name>`
 */
export function deriveSubnetTiers({ files, vars }) {
  const blocks = files.flatMap((f) => parseHclBlocks(f.content)).filter((b) => b.blockType === 'resource' && b.labels.length === 2);
  const detailsOf = (type, name) => extractResourceDetails(files, { blockType: 'resource', labels: [type, name] }, vars)?.attributes ?? {};
  const live = (details) => !(details.count?.resolved && details.count.value === 0);
  const ofType = (type) => blocks.filter((b) => b.labels[0] === type).map((b) => ({ name: b.labels[1], d: detailsOf(type, b.labels[1]) })).filter((x) => live(x.d));

  const text = (entry) => (entry ? (entry.resolved ? String(entry.value) : String(entry.raw)) : undefined);
  const refName = (entry, type) => new RegExp(`^${type}\\.([A-Za-z_][\\w-]*)`).exec(text(entry) ?? '')?.[1];

  // routes per route table: inline `route {}` blocks and standalone aws_route resources
  const TARGETS = ['gateway_id', 'nat_gateway_id', 'transit_gateway_id', 'vpc_endpoint_id', 'vpc_peering_connection_id', 'network_interface_id', 'egress_only_gateway_id', 'carrier_gateway_id', 'core_network_arn', 'local_gateway_id', 'instance_id'];
  const kindOfTarget = (raw) => (/^(aws_internet_gateway\.|igw-)/.test(raw) ? 'igw' : /^(aws_nat_gateway\.|nat-)/.test(raw) ? 'nat' : 'other');
  const routeFrom = (get) => {
    const cidrEntry = get('cidr_block') ?? get('destination_cidr_block') ?? get('ipv6_cidr_block') ?? get('destination_ipv6_cidr_block');
    const targetKey = TARGETS.find((k) => get(k));
    if (!cidrEntry && !targetKey) return null;
    return {
      cidr: cidrEntry?.resolved ? String(cidrEntry.value) : undefined,
      target: targetKey ? kindOfTarget(text(get(targetKey))) : 'other',
      targetKey,
    };
  };

  const tables = new Map();
  for (const t of ofType('aws_route_table')) {
    const keys = Object.keys(t.d);
    const opaque = keys.some((k) => k.startsWith('dynamic.route') || k === 'route');
    const routes = [];
    const indices = new Set(keys.map((k) => /^route(?:\[(\d+)\])?\./.exec(k)).filter(Boolean).map((m) => m[1] ?? ''));
    for (const i of indices) {
      const p = i === '' ? 'route.' : `route[${i}].`;
      const r = routeFrom((f) => t.d[`${p}${f}`]);
      if (r) routes.push(r);
    }
    tables.set(t.name, { routes, opaque });
  }
  for (const r of ofType('aws_route')) {
    const table = refName(r.d.route_table_id, 'aws_route_table');
    if (!table || !tables.has(table)) continue;
    const route = routeFrom((f) => r.d[f]);
    if (route) tables.get(table).routes.push(route);
  }

  const classify = (name) => {
    const table = tables.get(name);
    if (!table) return { tier: null, reason: `route table ${name} is not in the source` };
    if (table.opaque) return { tier: null, reason: `route table ${name} has dynamic or unresolved routes` };
    const isDefault = (r) => r.cidr === '0.0.0.0/0' || r.cidr === '::/0';
    const toInternet = table.routes.filter((r) => r.target === 'igw' || r.target === 'nat');
    if (toInternet.some((r) => r.cidr === undefined)) return { tier: null, reason: `a route of ${name} to an internet or NAT gateway has an unresolved destination` };
    const v4 = table.routes.filter((r) => r.cidr === '0.0.0.0/0');
    const v6 = table.routes.filter((r) => r.cidr === '::/0');
    if (table.routes.some((r) => r.target === 'igw' && !isDefault(r))) return { tier: null, reason: `${name} has a non-default route to an internet gateway` };
    if (v4.some((r) => r.target === 'igw')) return { tier: 'public', reason: `default route of ${name} goes to an internet gateway` };
    if (v4.some((r) => r.target === 'nat')) return { tier: 'private', reason: `default route of ${name} goes to a NAT gateway` };
    if (v4.some((r) => r.target === 'other')) return { tier: null, reason: `default route of ${name} goes through a gateway type that is not evaluated` };
    if (v6.some((r) => r.target === 'igw')) return { tier: null, reason: `${name} has an IPv6-only route to an internet gateway` };
    if (table.routes.some((r) => isDefault(r))) return { tier: null, reason: `default route of ${name} goes through a gateway type that is not evaluated` };
    return { tier: 'isolated', reason: `${name} has no default route` };
  };

  const associations = ofType('aws_route_table_association').map((a) => ({ subnet: refName(a.d.subnet_id, 'aws_subnet'), table: refName(a.d.route_table_id, 'aws_route_table') }));

  const result = new Map();
  for (const s of ofType('aws_subnet')) {
    const mine = associations.filter((a) => a.subnet === s.name);
    const key = `aws_subnet.${s.name}`;
    if (mine.length === 0) result.set(key, { tier: null, reason: 'no explicit aws_route_table_association: the VPC main route table applies and is not evaluated' });
    else if (mine.length > 1 || !mine[0].table) result.set(key, { tier: null, reason: 'route table association is ambiguous' });
    else result.set(key, classify(mine[0].table));
  }
  return result;
}
