#!/usr/bin/env node
// Builds viewer data for the SYNTHETIC Azure, GCP and OCI samples
// (examples/sample-{azure,gcp,oci}). Same pipeline as the AWS sample: DOT derived
// from references, manifest rules, placement from references + per-provider catalog.
//
//   node scripts/build-cloud-samples.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../lib/catalog/load-catalog.mjs';
import { parseDotGraph } from '../lib/parse/parse-dot-graph.mjs';
import { parseResourceAddress } from '../lib/parse/parse-resource-address.mjs';
import { parseTfvars } from '../lib/parse/parse-tfvars.mjs';
import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';
import { inferPlacementFromReferences } from '../lib/compile/infer-placement.mjs';
import { extractResourceDetails, entityDetails } from '../lib/extract/extract-resource-details.mjs';
import { validateManifest } from '../lib/manifest/validate-manifest.mjs';
import { lintManifest } from '../lib/manifest/lint-manifest.mjs';
import { dotFromTerraform } from './lib/sample-dot.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = await loadCatalog(path.join(root, 'catalog', 'providers'));

// [terraform type, entity kind] pairs; `null` kind = deliberately not drawn
const CLOUDS = {
  azure: {
    label: 'azure',
    rules: [
      ['azurerm_resource_group', 'azure.resource_group'], ['azurerm_virtual_network', 'azure.vnet'], ['azurerm_subnet', 'azure.subnet'],
      ['azurerm_public_ip', 'azure.public_ip'], ['azurerm_nat_gateway', 'azure.nat_gateway'], ['azurerm_lb', 'azure.lb'],
      ['azurerm_network_security_group', 'azure.nsg'], ['azurerm_kubernetes_cluster', 'azure.aks.cluster'],
      ['azurerm_kubernetes_cluster_node_pool', 'azure.aks.nodepool'], ['azurerm_linux_virtual_machine', 'azure.vm'],
      ['azurerm_private_endpoint', 'azure.private_endpoint'], ['azurerm_postgresql_flexible_server', 'azure.postgres'],
      ['azurerm_mssql_server', 'azure.sql.server'], ['azurerm_mssql_database', 'azure.sql.database'], ['azurerm_redis_cache', 'azure.redis'],
      ['azurerm_cosmosdb_account', 'azure.cosmos'], ['azurerm_dns_zone', 'azure.dns.zone'], ['azurerm_dns_a_record', 'azure.dns.record'],
      ['azurerm_user_assigned_identity', 'azure.identity'], ['azurerm_key_vault', 'azure.keyvault'], ['azurerm_storage_account', 'azure.storage'],
      ['azurerm_container_registry', 'azure.acr'],
      ['azurerm_virtual_network_peering', { link: { fromType: 'azurerm_virtual_network', toType: 'azurerm_virtual_network', label: 'peers' } }],
      ['azurerm_subnet_network_security_group_association', { link: { fromType: 'azurerm_subnet', toType: 'azurerm_network_security_group', label: 'secured by' } }],
      ['azurerm_nat_gateway_public_ip_association', { link: { fromType: 'azurerm_nat_gateway', toType: 'azurerm_public_ip', label: 'uses' } }],
      ['azurerm_subnet_nat_gateway_association', { link: { fromType: 'azurerm_subnet', toType: 'azurerm_nat_gateway', label: 'egress via' } }], ['azurerm_role_assignment', null], ['azurerm_network_interface', null],
    ],
    edgeLabels: [
      { fromKind: 'azure.aks.cluster', toKind: 'azure.identity', label: 'control-plane identity' },
      { fromKind: 'azure.private_endpoint', toKind: 'azure.keyvault', label: 'connects' },
      { fromKind: 'azure.dns.record', toKind: 'azure.public_ip', label: 'points to' },
    ],
    legend: { default: 'Resource groups', net: 'Network', eks: 'AKS', compute: 'VMs', data: 'Data services', edgeapp: 'LB, DNS & endpoints', iam: 'Identity', cfg: 'Secrets & storage' },
  },
  gcp: {
    label: 'gcp',
    rules: [
      ['google_compute_network', 'gcp.vpc'], ['google_compute_subnetwork', 'gcp.subnet'], ['google_compute_firewall', 'gcp.firewall'],
      ['google_compute_router', 'gcp.router'], ['google_compute_router_nat', 'gcp.nat'], ['google_service_account', 'gcp.service_account'],
      ['google_project_iam_member', 'gcp.iam.binding'], ['google_container_cluster', 'gcp.gke.cluster'], ['google_container_node_pool', 'gcp.gke.nodepool'],
      ['google_sql_database_instance', 'gcp.sql.instance'], ['google_redis_instance', 'gcp.redis'], ['google_compute_instance', 'gcp.vm'],
      ['google_compute_forwarding_rule', 'gcp.lb'], ['google_storage_bucket', 'gcp.bucket'], ['google_artifact_registry_repository', 'gcp.artifact_registry'],
      ['google_secret_manager_secret', 'gcp.secret'], ['google_dns_managed_zone', 'gcp.dns.zone'], ['google_dns_record_set', 'gcp.dns.record'],
      ['google_service_account_iam_member', null], ['google_compute_region_backend_service', null],
    ],
    edgeLabels: [
      { fromKind: 'gcp.gke.nodepool', toKind: 'gcp.service_account', label: 'runs as' },
      { fromKind: 'gcp.iam.binding', toKind: 'gcp.service_account', label: 'grants' },
      { fromKind: 'gcp.dns.record', toKind: 'gcp.lb', label: 'points to' },
    ],
    legend: { net: 'Network', eks: 'GKE', compute: 'VMs', data: 'Data services', edgeapp: 'LB & DNS', iam: 'IAM', cfg: 'Secrets & storage' },
  },
  oci: {
    label: 'oci',
    rules: [
      ['oci_identity_compartment', 'oci.compartment'], ['oci_core_vcn', 'oci.vcn'], ['oci_core_internet_gateway', 'oci.internet_gateway'],
      ['oci_core_nat_gateway', 'oci.nat_gateway'], ['oci_core_service_gateway', 'oci.service_gateway'], ['oci_core_route_table', 'oci.route_table'],
      ['oci_core_security_list', 'oci.security_list'], ['oci_core_network_security_group', 'oci.nsg'], ['oci_core_subnet', 'oci.subnet'],
      ['oci_containerengine_cluster', 'oci.oke.cluster'], ['oci_containerengine_node_pool', 'oci.oke.nodepool'], ['oci_core_instance', 'oci.instance'],
      ['oci_load_balancer_load_balancer', 'oci.lb'], ['oci_mysql_mysql_db_system', 'oci.mysql'], ['oci_database_autonomous_database', 'oci.adb'],
      ['oci_objectstorage_bucket', 'oci.bucket'], ['oci_kms_vault', 'oci.vault'], ['oci_identity_dynamic_group', 'oci.dynamic_group'],
      ['oci_identity_policy', 'oci.policy'], ['oci_dns_zone', 'oci.dns.zone'], ['oci_dns_rrset', 'oci.dns.record'],
    ],
    edgeLabels: [
      { fromKind: 'oci.policy', toKind: 'oci.dynamic_group', label: 'grants to' },
      { fromKind: 'oci.oke.cluster', toKind: 'oci.subnet', label: 'API endpoint' },
      { fromKind: 'oci.oke.nodepool', toKind: 'oci.subnet', label: 'worker nodes' },
      { fromKind: 'oci.dns.record', toKind: 'oci.lb', label: 'points to' },
    ],
    legend: { default: 'Compartments', net: 'Network', eks: 'OKE', compute: 'VMs', data: 'Data services', edgeapp: 'LB & DNS', iam: 'IAM', cfg: 'Secrets & storage' },
  },
};

const outDir = path.join(root, 'viewer', 'data');
const registered = [];
let exitCode = 0;

for (const [cloud, cfg] of Object.entries(CLOUDS)) {
  const dir = path.join(root, 'examples', `sample-${cloud}`);
  const files = await Promise.all((await fs.readdir(dir)).filter((f) => f.endsWith('.tf')).sort()
    .map(async (f) => ({ filePath: f, content: await fs.readFile(path.join(dir, f), 'utf8') })));

  const manifest = {
    repoId: cloud,
    // [type, kind]: kind = string -> entity, null -> not drawn, { link } -> not drawn, becomes an edge
    rules: cfg.rules.map(([type, kind]) => (typeof kind === 'string' ? { match: { type }, entity: { kind, idFrom: 'name' } } : kind?.link ? { match: { type }, link: kind.link } : { match: { type }, ignore: true })),
  };
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`invalid ${cloud} manifest: ${errors.join('; ')}`);
  for (const f of lintManifest(manifest, catalog)) { console.log(`${f.level} [${cloud}] ${f.message}`); if (f.level === 'error') exitCode = 1; }

  for (const envFile of (await fs.readdir(path.join(dir, 'envs'))).filter((f) => f.endsWith('.tfvars')).sort().reverse()) {
    const name = envFile.replace(/\.tfvars$/, '');
    const id = `${cloud}_${name}`;
    const vars = parseTfvars(await fs.readFile(path.join(dir, 'envs', envFile), 'utf8'));
    const parsed = parseDotGraph(dotFromTerraform(files, vars));
    const compiled = compileEnvironmentGraph({
      environment: id,
      repoGraphs: [{ repoId: cloud, manifest, nodes: parsed.nodes, edges: parsed.edges }],
      catalog,
      inferPlacement: (entities) => inferPlacementFromReferences({ entities, files: { [cloud]: files }, vars, catalog }),
      edgeLabels: cfg.edgeLabels,
    });
    for (const entity of compiled.entities) {
      const p = parseResourceAddress(entity.sourceAddress);
      const d = p && extractResourceDetails(files, { blockType: 'resource', labels: [p.type, p.name] }, vars);
      if (d) entity.details = entityDetails(d.attributes);
    }
    compiled.legend = cfg.legend;
    await fs.writeFile(path.join(outDir, `${id}.json`), JSON.stringify(compiled, null, 2) + '\n', 'utf8');
    registered.push({ id, label: `${cfg.label} / ${name}`, source: `examples/sample-${cloud}/envs/${envFile}` });
    console.log(`${id}: ${compiled.entities.length} entities, ${compiled.edges.length} edges, unresolved placements ${compiled.unresolvedPlacements.length}, unmapped ${compiled.coverage[cloud].unmapped.length}`);
    for (const u of compiled.unresolvedPlacements) console.log(`  ambiguous: ${u.entityId} (${u.candidateCount} ${u.parentKind})`);
    for (const u of compiled.coverage[cloud].unmapped) console.log(`  unmapped: ${u}`);
  }
}

const envPath = path.join(outDir, 'environments.json');
const existing = JSON.parse(await fs.readFile(envPath, 'utf8')).environments.filter((e) => !registered.some((r) => r.id === e.id));
await fs.writeFile(envPath, JSON.stringify({ environments: [...existing, ...registered] }, null, 2) + '\n', 'utf8');
await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
process.exit(exitCode);
