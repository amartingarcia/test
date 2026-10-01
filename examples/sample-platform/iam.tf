locals {
  trust_eks = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "eks.amazonaws.com" } }] })
  trust_ec2 = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }] })
  trust_irsa = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity", Principal = { Federated = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/EXAMPLE" } }] })
}

resource "aws_iam_role" "cluster" {
  assume_role_policy = local.trust_eks
  name = "prod-eks-cluster"
  path = "/"
}

resource "aws_iam_role" "node" {
  assume_role_policy = local.trust_ec2
  name = "prod-eks-node"
  path = "/"
}

resource "aws_iam_role" "orders_api_irsa" {
  assume_role_policy = local.trust_irsa
  name = "prod-orders-api-irsa"
  path = "/service-role/"
}

resource "aws_iam_role" "ec2_ssm" {
  assume_role_policy = local.trust_ec2
  count = var.enable_shared_vpc ? 1 : 0
  name = "shared-ec2-ssm"
  path = "/"
}

resource "aws_iam_instance_profile" "ec2" {
  count = var.enable_shared_vpc ? 1 : 0
  name = "shared-ec2"
  role = aws_iam_role.ec2_ssm[0].name
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

# IRSA roles of the workloads in examples/sample-k8s (prod only)
resource "aws_iam_role" "wl_web" {
  assume_role_policy = local.trust_irsa
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-web"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_api" {
  assume_role_policy = local.trust_irsa
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-api"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_worker" {
  assume_role_policy = local.trust_irsa
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-worker"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_payments" {
  assume_role_policy = local.trust_irsa
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-payments"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_karpenter" {
  assume_role_policy = local.trust_irsa
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-karpenter"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_karpenter_node" {
  assume_role_policy = local.trust_irsa
  count = var.enable_workload_roles ? 1 : 0
  name  = "KarpenterNodeRole-shop-prod"
  path  = "/"
}
