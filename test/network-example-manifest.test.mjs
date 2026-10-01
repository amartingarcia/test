import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { validateManifest } from '../lib/manifest/validate-manifest.mjs';
import { matchEntity } from '../lib/manifest/match-entity.mjs';
import { parseDotGraph } from '../lib/parse/parse-dot-graph.mjs';

async function loadNetworkManifest() {
  const raw = await fs.readFile(
    new URL('../examples/manifests/network.example.manifest.json', import.meta.url),
    'utf8'
  );
  return JSON.parse(raw);
}

test('the checked-in network example manifest is structurally valid', async () => {
  const manifest = await loadNetworkManifest();
  assert.deepEqual(validateManifest(manifest), []);
});

test('end-to-end: DOT -> parsed nodes -> matched entities for a representative network graph', async () => {
  const manifest = await loadNetworkManifest();

  const dot = `
digraph {
	subgraph "root" {
		"[root] aws_vpc.main (expand)" [label = "aws_vpc.main", shape = "box"]
		"[root] aws_subnet.public (expand)" [label = "aws_subnet.public", shape = "box"]
		"[root] aws_subnet.private (expand)" [label = "aws_subnet.private", shape = "box"]
		"[root] aws_internet_gateway.main (expand)" [label = "aws_internet_gateway.main", shape = "box"]
		"[root] aws_nat_gateway.main (expand)" [label = "aws_nat_gateway.main", shape = "box"]
		"[root] aws_security_group.default (expand)" [label = "aws_security_group.default", shape = "box"]
		"[root] data.aws_availability_zones.available (expand)" [label = "data.aws_availability_zones.available", shape = "box"]
		"[root] aws_subnet.public (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_subnet.private (expand)" -> "[root] aws_vpc.main (expand)"
		"[root] aws_nat_gateway.main (expand)" -> "[root] aws_subnet.public (expand)"
	}
}
`;

  const { nodes } = parseDotGraph(dot);
  assert.equal(nodes.length, 7);

  const entities = nodes.map((node) => matchEntity(node, manifest)).filter(Boolean);

  // every node in this representative graph is covered by the manifest
  assert.equal(entities.length, nodes.length);

  const byKind = Object.fromEntries(entities.map((e) => [e.sourceAddress, e.kind]));
  assert.equal(byKind['aws_vpc.main'], 'aws.vpc');
  assert.equal(byKind['aws_subnet.public'], 'aws.subnet.public');
  assert.equal(byKind['aws_subnet.private'], 'aws.subnet.private');
  assert.equal(byKind['aws_internet_gateway.main'], 'aws.internet_gateway');
  assert.equal(byKind['aws_nat_gateway.main'], 'aws.nat_gateway');
  assert.equal(byKind['aws_security_group.default'], 'aws.security_group');
  assert.equal(byKind['data.aws_availability_zones.available'], 'aws.availability_zones.lookup');

  // boundary wiring: subnets/gateways/SGs declare the VPC's full kind as
  // their boundary, so Layer C can resolve it to a concrete entity (not a
  // free-text label) — see the boundary-resolution decision in
  // odd/tasks/terraform-infra-diagram.md.
  const vpcEntity = entities.find((e) => e.kind === 'aws.vpc');
  assert.equal(vpcEntity.boundary, null); // the VPC itself has no enclosing boundary
  const publicSubnet = entities.find((e) => e.kind === 'aws.subnet.public');
  assert.equal(publicSubnet.boundary, 'aws.vpc');
});

test('a resource type absent from the manifest is reported as unmapped, not silently dropped', async () => {
  const manifest = await loadNetworkManifest();
  const unknownNode = { address: 'aws_flow_log.vpc', modulePath: [], isData: false, type: 'aws_flow_log', name: 'vpc', index: null };

  assert.equal(matchEntity(unknownNode, manifest), null);
});
