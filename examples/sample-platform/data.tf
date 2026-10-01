resource "aws_db_subnet_group" "data" {
  name       = "data"
  subnet_ids = [aws_subnet.prod_data.id]
}

resource "aws_db_instance" "orders" {
  identifier             = "orders"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = var.db_instance_class
  allocated_storage      = 100
  multi_az               = true
  storage_encrypted      = true
  db_subnet_group_name   = aws_db_subnet_group.data.name
  vpc_security_group_ids = [aws_security_group.prod_default.id]
}

resource "aws_docdb_subnet_group" "data" {
  name       = "docdb-data"
  subnet_ids = [aws_subnet.prod_data.id]
}

resource "aws_docdb_cluster" "reports" {
  cluster_identifier      = "reports"
  engine_version          = "5.0.0"
  storage_encrypted       = true
  backup_retention_period = 7
  db_subnet_group_name    = aws_docdb_subnet_group.data.name
}

resource "aws_elasticache_subnet_group" "data" {
  name       = "cache-data"
  subnet_ids = [aws_subnet.prod_data.id]
}

resource "aws_elasticache_replication_group" "sessions" {
  replication_group_id = "sessions"
  description          = "Session cache"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.r6g.large"
  num_cache_clusters   = 2
  subnet_group_name    = aws_elasticache_subnet_group.data.name
}

resource "aws_opensearch_domain" "logs" {
  domain_name    = "logs"
  engine_version = "OpenSearch_2.13"

  cluster_config {
    instance_type  = "r6g.large.search"
    instance_count = 3
  }

  vpc_options {
    subnet_ids = [aws_subnet.prod_data.id]
  }
}
