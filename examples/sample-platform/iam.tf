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
  name = "shared-ec2-ssm"
  path = "/"
}

resource "aws_iam_instance_profile" "ec2" {
  name = "shared-ec2"
  role = aws_iam_role.ec2_ssm.name
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}
