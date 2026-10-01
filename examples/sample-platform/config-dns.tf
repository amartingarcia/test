resource "aws_ssm_parameter" "db_endpoint" {
  name  = "/prod/orders/db/endpoint"
  type  = "String"
  value = aws_db_instance.orders.endpoint
}

resource "aws_ssm_parameter" "docdb_endpoint" {
  count = var.enable_docdb ? 1 : 0
  name  = "/prod/reports/docdb/endpoint"
  type  = "String"
  value = aws_docdb_cluster.reports[0].endpoint
}

resource "aws_ssm_parameter" "redis_endpoint" {
  name  = "/prod/sessions/redis/endpoint"
  type  = "String"
  value = aws_elasticache_replication_group.sessions.primary_endpoint_address
}

resource "aws_ssm_parameter" "opensearch_endpoint" {
  count = var.opensearch_enabled ? 1 : 0
  name  = "/prod/logs/opensearch/endpoint"
  type  = "String"
  value = aws_opensearch_domain.logs[0].endpoint
}

resource "aws_route53_zone" "main" {
  name = "example.com"
}

resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.example.com"
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "www.example.com"
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "bastion" {
  count = var.enable_shared_vpc ? 1 : 0
  zone_id = aws_route53_zone.main.zone_id
  name    = "bastion.example.com"
  type    = "A"
  ttl     = 300
  records = [aws_instance.bastion[0].public_ip]
}
