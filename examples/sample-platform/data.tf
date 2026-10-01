resource "aws_db_subnet_group" "data" {
  name       = "data"
  subnet_ids = [aws_subnet.prod_data.id, aws_subnet.prod_data_b.id]
}

resource "aws_db_instance" "orders" {
  identifier             = "orders"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = var.db_instance_class
  allocated_storage      = var.db_storage_gb
  multi_az               = var.db_multi_az
  storage_encrypted      = true
  username               = "orders_admin"
  manage_master_user_password = true
  db_subnet_group_name   = aws_db_subnet_group.data.name
  vpc_security_group_ids = [aws_security_group.prod_default.id]
}

resource "aws_docdb_subnet_group" "data" {
  count = var.enable_docdb ? 1 : 0
  name       = "docdb-data"
  subnet_ids = [aws_subnet.prod_data.id, aws_subnet.prod_data_b.id]
}

resource "aws_docdb_cluster" "reports" {
  count = var.enable_docdb ? 1 : 0
  cluster_identifier      = "reports"
  engine_version          = "5.0.0"
  storage_encrypted       = true
  backup_retention_period = 7
  master_username         = "reports_admin"
  master_password         = var.docdb_master_password
  skip_final_snapshot     = true
  db_subnet_group_name    = aws_docdb_subnet_group.data[0].name
}

resource "aws_elasticache_subnet_group" "data" {
  name       = "cache-data"
  subnet_ids = [aws_subnet.prod_data.id, aws_subnet.prod_data_b.id]
}

resource "aws_elasticache_replication_group" "sessions" {
  replication_group_id = "sessions"
  description          = "Session cache"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.r6g.large"
  num_cache_clusters   = var.redis_nodes
  subnet_group_name    = aws_elasticache_subnet_group.data.name
}

resource "aws_opensearch_domain" "logs" {
  count = var.opensearch_enabled ? 1 : 0
  domain_name    = "logs"
  engine_version = "OpenSearch_2.13"

  cluster_config {
    instance_type  = "r6g.large.search"
    instance_count = var.opensearch_nodes
  }

  vpc_options {
    subnet_ids = [aws_subnet.prod_data.id, aws_subnet.prod_data_b.id]
  }
}
