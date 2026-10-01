# Synthetic sample (invented values) used to demo the viewer. Not a real environment.

resource "aws_vpc" "prod" {
  cidr_block           = "10.10.0.0/16"
  enable_dns_hostnames = true
}

resource "aws_vpc" "shared" {
  count = var.enable_shared_vpc ? 1 : 0
  cidr_block = "10.20.0.0/16"
}

resource "aws_vpc_peering_connection" "prod_shared" {
  count = var.enable_shared_vpc ? 1 : 0
  vpc_id      = aws_vpc.prod.id
  peer_vpc_id = aws_vpc.shared[0].id
  auto_accept = true
}

resource "aws_internet_gateway" "prod" {
  vpc_id = aws_vpc.prod.id
}

resource "aws_internet_gateway" "shared" {
  count = var.enable_shared_vpc ? 1 : 0
  vpc_id = aws_vpc.shared[0].id
}

resource "aws_subnet" "prod_public" {
  vpc_id     = aws_vpc.prod.id
  cidr_block = "10.10.0.0/20"
}

resource "aws_subnet" "prod_private" {
  vpc_id     = aws_vpc.prod.id
  cidr_block = "10.10.16.0/20"
}

resource "aws_subnet" "prod_data" {
  vpc_id     = aws_vpc.prod.id
  cidr_block = "10.10.32.0/20"
}

resource "aws_subnet" "shared_public" {
  count = var.enable_shared_vpc ? 1 : 0
  vpc_id     = aws_vpc.shared[0].id
  cidr_block = "10.20.0.0/20"
}

resource "aws_subnet" "shared_private" {
  count = var.enable_shared_vpc ? 1 : 0
  vpc_id     = aws_vpc.shared[0].id
  cidr_block = "10.20.16.0/20"
}

resource "aws_eip" "prod_nat" {
  domain = "vpc"
}

resource "aws_eip" "shared_nat" {
  count = var.enable_shared_vpc ? 1 : 0
  domain = "vpc"
}

resource "aws_nat_gateway" "prod" {
  subnet_id     = aws_subnet.prod_public.id
  allocation_id = aws_eip.prod_nat.id
}

resource "aws_nat_gateway" "shared" {
  count = var.enable_shared_vpc ? 1 : 0
  subnet_id     = aws_subnet.shared_public[0].id
  allocation_id = aws_eip.shared_nat[0].id
}

resource "aws_security_group" "prod_default" {
  name   = "prod-default"
  vpc_id = aws_vpc.prod.id
}

resource "aws_security_group" "shared_default" {
  count = var.enable_shared_vpc ? 1 : 0
  name   = "shared-default"
  vpc_id = aws_vpc.shared[0].id
}
