# --------------------------------------------------------------------------
# VPC flow logs.
#
# The log group is created here rather than left to be auto-created: an
# auto-created group has infinite retention, which is both a cost leak and a
# Governance 12.2 breach that nobody notices for a year.
#
# The consumer of this is a metric filter on rejected connections to the data
# tier (observability.tf in the calling root) - hence the group name is an
# output rather than something the caller has to reconstruct by hand.
# --------------------------------------------------------------------------

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = var.flow_log_traffic_type
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/nt/${var.env}/vpc-flow-logs"
  retention_in_days = var.flow_log_retention_days
}

# Named nt-<env>-flow-logs, and that is load-bearing, not cosmetic: the bucket
# and KMS deny guards (D36) key off arn:aws:iam::<account>:role/nt-*, so a role
# outside that prefix is silently denied wherever it touches Neoting data.
resource "aws_iam_role" "flow_logs" {
  name = "nt-${var.env}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-logs"
  role = aws_iam_role.flow_logs.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}
