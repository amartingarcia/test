resource "aws_lb" "public" {
  name               = "edge-alb"
  load_balancer_type = "application"
  subnets            = [aws_subnet.prod_public.id]
  security_groups    = [aws_security_group.prod_default.id]
}

resource "aws_instance" "bastion" {
  ami                  = "ami-0a1b2c3d4e5f67890"
  instance_type        = "t3.micro"
  subnet_id            = aws_subnet.shared_public.id
  iam_instance_profile = aws_iam_instance_profile.ec2.name
}

resource "aws_instance" "ci_runner" {
  ami           = "ami-0a1b2c3d4e5f67890"
  instance_type = "t3.large"
  subnet_id     = aws_subnet.shared_private.id
}

resource "aws_instance" "legacy_api" {
  ami           = "ami-0a1b2c3d4e5f67890"
  instance_type = "m5.large"
  subnet_id     = aws_subnet.prod_private.id
}

resource "aws_eks_cluster" "this" {
  name     = "prod-cluster"
  version  = var.eks_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = [aws_subnet.prod_private.id]
    endpoint_private_access = true
    endpoint_public_access  = false
  }
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = [aws_subnet.prod_private.id]
  instance_types  = ["m5.large", "m5a.large"]
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = 2
    max_size     = 6
    desired_size = 3
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
  addon_version = "v1.29.0-eksbuild.1"
}
