resource "aws_lb" "public" {
  name               = "edge-alb"
  load_balancer_type = "application"
  subnets            = [aws_subnet.prod_public.id, aws_subnet.prod_public_b.id]
  security_groups    = [aws_security_group.prod_default.id]
}

resource "aws_instance" "bastion" {
  count = var.enable_shared_vpc ? 1 : 0
  ami                  = "ami-0a1b2c3d4e5f67890"
  instance_type        = "t3.micro"
  subnet_id            = aws_subnet.shared_public[0].id
  associate_public_ip_address = true
  iam_instance_profile = aws_iam_instance_profile.ec2[0].name
}

resource "aws_instance" "ci_runner" {
  count = var.enable_shared_vpc ? 1 : 0
  ami           = "ami-0a1b2c3d4e5f67890"
  instance_type = "t3.large"
  subnet_id     = aws_subnet.shared_private[0].id
}

resource "aws_instance" "legacy_api" {
  count = var.enable_legacy ? 1 : 0
  ami           = "ami-0a1b2c3d4e5f67890"
  instance_type = "m5.large"
  subnet_id     = aws_subnet.prod_private.id
}

resource "aws_eks_cluster" "this" {
  name     = "prod-cluster"
  version  = var.eks_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = [aws_subnet.prod_private.id, aws_subnet.prod_private_b.id]
    endpoint_private_access = true
    endpoint_public_access  = false
  }
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = [aws_subnet.prod_private.id, aws_subnet.prod_private_b.id]
  instance_types  = var.node_instance_types
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.node_min
    max_size     = var.node_max
    desired_size = var.node_desired
  }
}

resource "aws_eks_node_group" "system" {
  count           = var.enable_system_nodegroup ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = [aws_subnet.prod_private.id, aws_subnet.prod_private_b.id]
  instance_types  = ["m5.large"]
  capacity_type   = "ON_DEMAND"

  labels = {
    node-role = "system"
  }

  taint {
    key    = "CriticalAddonsOnly"
    effect = "NO_SCHEDULE"
  }

  scaling_config {
    min_size     = 2
    max_size     = 3
    desired_size = 2
  }
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name  = aws_eks_cluster.this.name
  addon_name    = "vpc-cni"
  addon_version = "v1.18.1-eksbuild.1"
}

resource "aws_eks_addon" "coredns" {
  cluster_name  = aws_eks_cluster.this.name
  addon_name    = "coredns"
  addon_version = "v1.11.1-eksbuild.9"
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name  = aws_eks_cluster.this.name
  addon_name    = "kube-proxy"
  addon_version = var.kube_proxy_version
}
