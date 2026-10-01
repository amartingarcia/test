import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveSubnetTiers } from '../lib/compile/derive-subnet-tier.mjs';
import { compileEnvironmentGraph } from '../lib/compile/compile-environment-graph.mjs';

const tf = (content) => [{ filePath: 'main.tf', content }];
const tiers = (content, vars = {}) => Object.fromEntries([...deriveSubnetTiers({ files: tf(content), vars })].map(([k, v]) => [k, v.tier]));

const NET = `
resource "aws_vpc" "v" { cidr_block = "10.0.0.0/16" }
resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.v.id }
resource "aws_nat_gateway" "nat" { subnet_id = aws_subnet.pub.id }
resource "aws_subnet" "pub" { vpc_id = aws_vpc.v.id }
resource "aws_subnet" "app" { vpc_id = aws_vpc.v.id }
resource "aws_subnet" "db" { vpc_id = aws_vpc.v.id }
`;

test('default route to an internet gateway is public; default route to a NAT gateway is private; no default route is isolated', () => {
  const t = tiers(`${NET}
resource "aws_route_table" "pub" {
  vpc_id = aws_vpc.v.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}
resource "aws_route_table" "app" { vpc_id = aws_vpc.v.id }
resource "aws_route" "app_nat" {
  route_table_id         = aws_route_table.app.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.nat.id
}
resource "aws_route_table" "db" { vpc_id = aws_vpc.v.id }
resource "aws_route_table_association" "pub" {
  subnet_id = aws_subnet.pub.id
  route_table_id = aws_route_table.pub.id
}
resource "aws_route_table_association" "app" {
  subnet_id = aws_subnet.app.id
  route_table_id = aws_route_table.app.id
}
resource "aws_route_table_association" "db" {
  subnet_id = aws_subnet.db.id
  route_table_id = aws_route_table.db.id
}
`);
  assert.deepEqual(t, { 'aws_subnet.pub': 'public', 'aws_subnet.app': 'private', 'aws_subnet.db': 'isolated' });
});

test('the name of the subnet is irrelevant', () => {
  const t = tiers(`
resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.v.id }
resource "aws_subnet" "private_but_really_public" { vpc_id = aws_vpc.v.id }
resource "aws_route" "r" {
  route_table_id = aws_route_table.t.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.igw.id
}
resource "aws_route_table" "t" { vpc_id = aws_vpc.v.id }
resource "aws_route_table_association" "a" {
  subnet_id = aws_subnet.private_but_really_public.id
  route_table_id = aws_route_table.t.id
}
`);
  assert.equal(t['aws_subnet.private_but_really_public'], 'public');
});

test('a subnet with no explicit association is not classified (the VPC main route table applies)', () => {
  const r = deriveSubnetTiers({ files: tf(NET), vars: {} });
  assert.equal(r.get('aws_subnet.app').tier, null);
  assert.match(r.get('aws_subnet.app').reason, /main route table/);
});

test('unresolved destinations, dynamic routes and non-default internet routes are reported, not guessed', () => {
  const r = deriveSubnetTiers({ files: tf(`${NET}
resource "aws_route_table" "a" {
  vpc_id = aws_vpc.v.id
  route {
    cidr_block = var.dest
    gateway_id = aws_internet_gateway.igw.id
  }
}
resource "aws_route_table" "b" {
  vpc_id = aws_vpc.v.id
  dynamic "route" {
    for_each = var.routes
    content { cidr_block = route.value }
  }
}
resource "aws_route_table" "c" {
  vpc_id = aws_vpc.v.id
  route {
    cidr_block = "10.9.0.0/16"
    gateway_id = aws_internet_gateway.igw.id
  }
}
resource "aws_route_table_association" "pub" {
  subnet_id = aws_subnet.pub.id
  route_table_id = aws_route_table.a.id
}
resource "aws_route_table_association" "app" {
  subnet_id = aws_subnet.app.id
  route_table_id = aws_route_table.b.id
}
resource "aws_route_table_association" "db"  { subnet_id = aws_subnet.db.id   route_table_id = aws_route_table.c.id }
`), vars: {} });
  for (const s of ['pub', 'app', 'db']) assert.equal(r.get(`aws_subnet.${s}`).tier, null, s);
});

test('a default route through a transit gateway is not classified', () => {
  const r = deriveSubnetTiers({ files: tf(`${NET}
resource "aws_route_table" "t" {
  vpc_id = aws_vpc.v.id
  route {
    cidr_block = "0.0.0.0/0"
    transit_gateway_id = aws_ec2_transit_gateway.tgw.id
  }
}
resource "aws_route_table_association" "app" {
  subnet_id = aws_subnet.app.id
  route_table_id = aws_route_table.t.id
}
`), vars: {} });
  assert.equal(r.get('aws_subnet.app').tier, null);
});

test('an aws_route gated by count = 0 does not exist', () => {
  const t = tiers(`${NET}
resource "aws_route_table" "t" { vpc_id = aws_vpc.v.id }
resource "aws_route" "r" {
  count = var.enable ? 1 : 0
  route_table_id = aws_route_table.t.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.igw.id
}
resource "aws_route_table_association" "app" {
  subnet_id = aws_subnet.app.id
  route_table_id = aws_route_table.t.id
}
`, { enable: false });
  assert.equal(t['aws_subnet.app'], 'isolated');
});

/* ---- compile hook ---- */
test('compile: refineKind changes the entity kind (and id) before placement; null leaves a finding', () => {
  const manifest = { repoId: 'r', rules: [{ match: { type: 'aws_subnet' }, entity: { kind: 'aws.subnet', idFrom: 'name' } }] };
  const nodes = [{ address: 'aws_subnet.a', modulePath: [], isData: false, type: 'aws_subnet', name: 'a', index: null }, { address: 'aws_subnet.b', modulePath: [], isData: false, type: 'aws_subnet', name: 'b', index: null }];
  const g = compileEnvironmentGraph({
    environment: 'e', repoGraphs: [{ repoId: 'r', manifest, nodes, edges: [] }],
    refineKind: ({ sourceAddress }) => (sourceAddress === 'aws_subnet.a' ? { kind: 'aws.subnet.public' } : { unresolved: 'no route table' }),
  });
  assert.deepEqual(g.entities.map((e) => e.kind), ['aws.subnet.public', 'aws.subnet']);
  assert.equal(g.entities[0].id, 'r:aws.subnet.public:a');
  assert.deepEqual(g.findings.map((f) => f.entityId), ['r:aws.subnet:b']);
});
