resource "aws_ssm_parameter" "db_endpoint" {
  name  = "/prod/orders/db/endpoint"
  type  = "String"
  value = aws_db_instance.orders.endpoint
}

resource "aws_ssm_parameter" "docdb_endpoint" {
  name  = "/prod/reports/docdb/endpoint"
  type  = "String"
  value = aws_docdb_cluster.reports.endpoint
}

resource "aws_ssm_parameter" "redis_endpoint" {
  name  = "/prod/sessions/redis/endpoint"
  type  = "String"
  value = aws_elasticache_replication_group.sessions.primary_endpoint_address
}

resource "aws_ssm_parameter" "opensearch_endpoint" {
  name  = "/prod/logs/opensearch/endpoint"
  type  = "String"
  value = aws_opensearch_domain.logs.endpoint
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
  zone_id = aws_route53_zone.main.zone_id
  name    = "bastion.example.com"
  type    = "A"
  ttl     = 300
  records = [aws_instance.bastion.public_ip]
}
