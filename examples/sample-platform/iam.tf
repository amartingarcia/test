resource "aws_iam_role" "cluster" {
  name = "prod-eks-cluster"
  path = "/"
}

resource "aws_iam_role" "node" {
  name = "prod-eks-node"
  path = "/"
}

resource "aws_iam_role" "orders_api_irsa" {
  name = "prod-orders-api-irsa"
  path = "/service-role/"
}

resource "aws_iam_role" "ec2_ssm" {
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
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-web"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_api" {
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-api"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_worker" {
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-worker"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_payments" {
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-payments"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_karpenter" {
  count = var.enable_workload_roles ? 1 : 0
  name  = "shop-prod-karpenter"
  path  = "/service-role/"
}

resource "aws_iam_role" "wl_karpenter_node" {
  count = var.enable_workload_roles ? 1 : 0
  name  = "KarpenterNodeRole-shop-prod"
  path  = "/"
}
