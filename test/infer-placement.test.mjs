import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inferPlacementFromReferences } from '../lib/compile/infer-placement.mjs';

const catalog = { kinds: {
  'aws.rds.instance': { placement: { parentKinds: ['aws.subnet.data', 'aws.vpc'] } },
} };

const ent = (kind, address, extra = {}) => ({ id: `r:${kind}:${address}`, kind, repoId: 'r', sourceAddress: address, parent: null, ...extra });
const tf = (content) => ({ r: [{ filePath: 'main.tf', content }] });

test('places an entity in the one parent-kind entity its attributes reference, even through an intermediate resource', () => {
  const entities = [
    ent('aws.subnet.data', 'aws_subnet.data_a'),
    ent('aws.subnet.data', 'aws_subnet.data_b'),
    ent('aws.rds.instance', 'aws_db_instance.orders'),
  ];
  const files = tf(`
resource "aws_db_instance" "orders" {
  db_subnet_group_name = aws_db_subnet_group.g.name
}
resource "aws_db_subnet_group" "g" {
  subnet_ids = [aws_subnet.data_b.id]
}
resource "aws_subnet" "data_a" { cidr_block = "10.0.1.0/24" }
resource "aws_subnet" "data_b" { cidr_block = "10.0.2.0/24" }
`);
  const { placements, unresolved } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.deepEqual(placements, [{ entityId: 'r:aws.rds.instance:aws_db_instance.orders', parent: 'r:aws.subnet.data:aws_subnet.data_b' }]);
  assert.deepEqual(unresolved, []);
});

test('references to several candidates of the same parent kind are reported, not guessed', () => {
  const entities = [
    ent('aws.subnet.data', 'aws_subnet.a'),
    ent('aws.subnet.data', 'aws_subnet.b'),
    ent('aws.rds.instance', 'aws_db_instance.orders'),
  ];
  const files = tf(`
resource "aws_db_instance" "orders" {
  subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]
}
`);
  const { placements, unresolved } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.deepEqual(placements, []);
  assert.deepEqual(unresolved, [{ entityId: 'r:aws.rds.instance:aws_db_instance.orders', parentKind: 'aws.subnet.data', candidateCount: 2 }]);
});

test('prefers the first parent kind that is referenced (data subnet before vpc)', () => {
  const entities = [
    ent('aws.vpc', 'aws_vpc.main'),
    ent('aws.subnet.data', 'aws_subnet.d'),
    ent('aws.rds.instance', 'aws_db_instance.orders'),
  ];
  const files = tf(`
resource "aws_db_instance" "orders" {
  vpc_id    = aws_vpc.main.id
  subnet_id = aws_subnet.d.id
}
`);
  const { placements } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.equal(placements[0].parent, 'r:aws.subnet.data:aws_subnet.d');
});

test('entities that already have a parent, or whose kind has no placement rule, are left alone', () => {
  const entities = [
    ent('aws.subnet.data', 'aws_subnet.d'),
    ent('aws.rds.instance', 'aws_db_instance.orders', { parent: 'r:aws.vpc:other' }),
    ent('aws.thing', 'aws_thing.t'),
  ];
  const files = tf('resource "aws_db_instance" "orders" { subnet_id = aws_subnet.d.id }\nresource "aws_thing" "t" { subnet_id = aws_subnet.d.id }');
  const { placements, unresolved } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.deepEqual(placements, []);
  assert.deepEqual(unresolved, []);
});

test('data-source references and cycles do not break the walk', () => {
  const entities = [ent('aws.subnet.data', 'aws_subnet.d'), ent('aws.rds.instance', 'aws_db_instance.orders')];
  const files = tf(`
resource "aws_db_instance" "orders" {
  az = data.aws_availability_zones.available.names[0]
  x  = aws_thing.a.id
}
resource "aws_thing" "a" {
  y = aws_thing.b.id
}
resource "aws_thing" "b" {
  y = aws_thing.a.id
  z = aws_subnet.d.id
}
`);
  const { placements } = inferPlacementFromReferences({ entities, files, vars: {}, catalog });
  assert.equal(placements.length, 1);
});
