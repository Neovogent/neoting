output "kms_key_arn" {
  value       = aws_kms_key.docs.arn
  description = "CMK protecting documents, exports, RDS and ElastiCache at rest, and the ECR repositories."
}

output "kms_key_id" {
  value       = aws_kms_key.docs.key_id
  description = "Key ID, for the APIs that want it rather than the ARN."
}

output "kms_alias_name" {
  value       = aws_kms_alias.docs.name
  description = "alias/nt-<env>-<suffix>."
}

output "bucket_names" {
  value       = local.bucket_names
  description = "Map of short key to full bucket name. Callers build ARNs from this rather than restating the naming convention."
}

output "bucket_ids" {
  value       = { for k, v in aws_s3_bucket.this : k => v.id }
  description = "Map of short key to bucket ID. Attach lifecycle rules and notifications with this so they depend on the bucket actually existing."
}

output "bucket_arns" {
  value       = { for k, v in aws_s3_bucket.this : k => v.arn }
  description = "Map of short key to bucket ARN."
}

output "bucket_regional_domain_names" {
  value       = { for k, v in aws_s3_bucket.this : k => v.bucket_regional_domain_name }
  description = "Regional endpoint per bucket - the form CloudFront origins need."
}

output "bucket_policy_ids" {
  value       = { for k, v in aws_s3_bucket_policy.this : k => v.id }
  description = <<-EOT
    Bucket name per attached policy. Resource-derived, unlike bucket_names, so
    reading it inside a resource argument creates a real ordering edge on the
    policy actually existing - which matters for anything AWS validates by
    test-writing at creation time (SES receipt rules).
  EOT
}
