-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('PRACTICE_ADMIN', 'CLIENT_ADMIN', 'PRACTICE_STANDARD', 'BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD');

-- CreateEnum
CREATE TYPE "OtpSessionScope" AS ENUM ('ONBOARDING', 'DELEGATED_UPLOAD', 'ITEM_MESSAGE');

-- CreateEnum
CREATE TYPE "DocumentChannel" AS ENUM ('WEB_UPLOAD', 'EMAIL', 'WHATSAPP', 'SMS_PORTAL', 'CHAT_UPLOAD', 'STRUCTURED_IMPORT', 'API');

-- CreateEnum
CREATE TYPE "Inbox" AS ENUM ('COSTS', 'SALES', 'UNROUTED');

-- CreateEnum
CREATE TYPE "DocumentState" AS ENUM ('RECEIVED', 'PROCESSING', 'TO_REVIEW', 'READY', 'PUBLISHED', 'ARCHIVED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'STATEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "DuplicateVerdict" AS ENUM ('PENDING', 'CONFIRMED_DUPLICATE', 'CONFIRMED_DIFFERENT', 'KEEP_BOTH');

-- CreateEnum
CREATE TYPE "RuleTier" AS ENUM ('USER', 'PAYMENT_METHOD', 'SUPPLIER_CUSTOMER', 'ACCOUNT_DEFAULT');

-- CreateEnum
CREATE TYPE "GuidanceLevel" AS ENUM ('ACCOUNT', 'PRACTICE_CORE', 'PRACTICE_SHARED');

-- CreateEnum
CREATE TYPE "GuidanceMode" AS ENUM ('MANUAL_REVIEW', 'AUTO_APPLY');

-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('PENDING', 'ACTIVE', 'RECONFIRM_DUE', 'LAPSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MatchState" AS ENUM ('UNMATCHED', 'SUGGESTED', 'CONFIRMED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "SupplierStatementLineStatus" AS ENUM ('IN_LEDGER_AND_NEOTING', 'IN_LEDGER_ONLY', 'NEOTING_ONLY', 'MISSING', 'NOT_ON_STATEMENT');

-- CreateEnum
CREATE TYPE "MatchKind" AS ENUM ('EXACT', 'PROBABILISTIC', 'PARTIAL_PAYMENT', 'BATCH_PAYMENT', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "ChaseDetectionEngine" AS ENUM ('UNMATCHED_TRANSACTION', 'SUPPLIER_STATEMENT_GAP', 'STATEMENT_PERIOD_GAP', 'LEDGER_TXN_NO_ATTACHMENT', 'EXPECTED_RECURRING_MISSING');

-- CreateEnum
CREATE TYPE "ChaseState" AS ENUM ('DETECTED', 'PROPOSED', 'APPROVED', 'SENT', 'REMINDED', 'ESCALATED', 'CLOSED_RECEIVED', 'CLOSED_UNAVAILABLE', 'CLOSED_DISMISSED', 'CLOSED_SUPPRESSED');

-- CreateEnum
CREATE TYPE "ProposalState" AS ENUM ('CREATED', 'REVIEWED', 'APPROVED', 'EXECUTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('XERO', 'QUICKBOOKS', 'SAGE', 'FREEAGENT');

-- CreateEnum
CREATE TYPE "PublishMode" AS ENUM ('MANUAL', 'AUTO', 'AI');

-- CreateEnum
CREATE TYPE "PublishState" AS ENUM ('QUEUED', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "practices" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_s3_key" TEXT,
    "country_code" TEXT NOT NULL DEFAULT 'GB',
    "base_currency" TEXT NOT NULL DEFAULT 'GBP',
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "registered_address" JSONB,
    "vat_number" TEXT,
    "vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "year_end_month" INTEGER,
    "year_end_day" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT,
    "name" TEXT NOT NULL,
    "trading_name" TEXT,
    "logo_s3_key" TEXT,
    "company_number" TEXT,
    "legal_structure" TEXT,
    "industry" TEXT,
    "website" TEXT,
    "registered_address" JSONB,
    "trading_address" JSONB,
    "country_code" TEXT NOT NULL DEFAULT 'GB',
    "base_currency" TEXT NOT NULL DEFAULT 'GBP',
    "vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "vat_number" TEXT,
    "vat_scheme" TEXT,
    "vat_frequency" TEXT,
    "vat_period_start" TIMESTAMP(3),
    "year_end_month" INTEGER,
    "year_end_day" INTEGER,
    "context_questionnaire" JSONB,
    "bookkeeping_managed_by" TEXT,
    "bookkeeping_frequency" TEXT,
    "next_deadline" TIMESTAMP(3),
    "practice_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "totp_secret_ref" TEXT,
    "totp_enabled_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "practice_id" TEXT,
    "business_id" TEXT,
    "role" "WorkspaceRole" NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hide_financial_fields" BOOLEAN NOT NULL DEFAULT false,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "role" TEXT,
    "mobile_e164" TEXT,
    "mobile_verified_at" TIMESTAMP(3),
    "email" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "receives_chases" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT,
    "business_id" TEXT,
    "email" TEXT,
    "mobile_e164" TEXT,
    "role" "WorkspaceRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "device_label" TEXT,
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_sessions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "user_id" TEXT,
    "scope" "OtpSessionScope" NOT NULL,
    "granted_item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "chase_id" TEXT,
    "requested_from_contact_id" TEXT,
    "otp_hash" TEXT,
    "otp_expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "link_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "byte_hash" TEXT NOT NULL,
    "perceptual_hash" TEXT,
    "channel" "DocumentChannel" NOT NULL,
    "submitter_user_id" TEXT,
    "submitter_label" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_local" TEXT,
    "routing_decision" JSONB,
    "routing_confidence" DOUBLE PRECISION,
    "inbox" "Inbox" NOT NULL DEFAULT 'UNROUTED',
    "state" "DocumentState" NOT NULL DEFAULT 'RECEIVED',
    "doc_type" "DocumentType",
    "supplier_name" TEXT,
    "customer_name" TEXT,
    "document_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "currency" TEXT,
    "total_pence" INTEGER,
    "tax_pence" INTEGER,
    "reference" TEXT,
    "category_code" TEXT,
    "description" TEXT,
    "project_ref" TEXT,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "parent_document_id" TEXT,
    "page_range" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extractions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "extractor_kind" TEXT NOT NULL,
    "model_version" TEXT,
    "prompt_version" TEXT,
    "ladder_rung" TEXT,
    "overall_confidence" DOUBLE PRECISION,
    "validator_results" JSONB,
    "is_accepted" BOOLEAN NOT NULL DEFAULT false,
    "keyed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_events" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "trace_id" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicates" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "document_aid" TEXT NOT NULL,
    "document_bid" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "verdict" "DuplicateVerdict" NOT NULL DEFAULT 'PENDING',
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "tier" "RuleTier" NOT NULL,
    "scope_key" TEXT,
    "conditions" JSONB,
    "sets" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_via" TEXT,
    "created_by_user_id" TEXT,
    "action_proposal_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guidance" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT,
    "business_id" TEXT,
    "level" "GuidanceLevel" NOT NULL,
    "mode" "GuidanceMode" NOT NULL DEFAULT 'MANUAL_REVIEW',
    "text" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guidance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "source_rule_id" TEXT,
    "source_guidance_id" TEXT,
    "model_version" TEXT,
    "accepted_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "decided_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'truelayer',
    "provider_ref" TEXT,
    "institution_name" TEXT,
    "consent_state" "ConsentState" NOT NULL DEFAULT 'PENDING',
    "consented_at" TIMESTAMP(3),
    "reconfirm_due" TIMESTAMP(3),
    "lapsed_at" TIMESTAMP(3),
    "token_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "provider_account_id" TEXT,
    "display_name" TEXT NOT NULL,
    "account_type" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "sort_code" TEXT,
    "account_last4" TEXT,
    "balance_pence" INTEGER,
    "balance_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_transaction_id" TEXT,
    "booked_at" TIMESTAMP(3) NOT NULL,
    "pending_at" TIMESTAMP(3),
    "amount_pence" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "description_raw" TEXT NOT NULL,
    "merchant_name" TEXT,
    "classification" TEXT,
    "balance_after_pence" INTEGER,
    "counterparty" JSONB,
    "standing_order_ref" TEXT,
    "import_batch_id" TEXT,
    "raw_payload_ref" TEXT,
    "match_state" "MatchState" NOT NULL DEFAULT 'UNMATCHED',
    "chase_suppressed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statements" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "account_id" TEXT,
    "document_id" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "opening_balance_pence" INTEGER,
    "closing_balance_pence" INTEGER,
    "gap_analysis" JSONB,
    "row_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_statements" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "document_id" TEXT,
    "supplier_name" TEXT NOT NULL,
    "statement_end_date" TIMESTAMP(3),
    "outstanding_balance_pence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_statement_lines" (
    "id" TEXT NOT NULL,
    "supplier_statement_id" TEXT NOT NULL,
    "reference" TEXT,
    "line_date" TIMESTAMP(3),
    "amount_pence" INTEGER,
    "status" "SupplierStatementLineStatus" NOT NULL DEFAULT 'MISSING',
    "matched_document_id" TEXT,

    CONSTRAINT "supplier_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "kind" "MatchKind" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "state" "MatchState" NOT NULL DEFAULT 'SUGGESTED',
    "matched_by_user_id" TEXT,
    "matched_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unmatched_at" TIMESTAMP(3),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chases" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "detection_engine" "ChaseDetectionEngine" NOT NULL,
    "transaction_id" TEXT,
    "item_refs" JSONB NOT NULL,
    "recipient_contact_id" TEXT,
    "state" "ChaseState" NOT NULL DEFAULT 'DETECTED',
    "schedule" JSONB,
    "first_sent_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_reason" TEXT,
    "closed_by_document_id" TEXT,
    "action_proposal_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chase_messages" (
    "id" TEXT NOT NULL,
    "chase_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'sms',
    "body" TEXT NOT NULL,
    "recipient_e164" TEXT,
    "provider_message_id" TEXT,
    "delivery_state" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chase_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_threads" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "asked_by_user_id" TEXT,
    "answered_via" TEXT,
    "asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),

    CONSTRAINT "item_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_workflows" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stages" JSONB NOT NULL,
    "applies_to" JSONB,
    "specificity" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT,
    "document_id" TEXT NOT NULL,
    "stage_index" INTEGER NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "rendered_summary" JSONB,
    "rendered_summary_hash" TEXT,
    "state" "ProposalState" NOT NULL DEFAULT 'CREATED',
    "created_by_user_id" TEXT,
    "created_by_model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "policy_proposal_id" TEXT,
    "outcome" JSONB,
    "trace_id" TEXT,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "org_ref" TEXT,
    "token_ref" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "health" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error_message" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_syncs" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "list_kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "integration_id" TEXT,
    "mode" "PublishMode" NOT NULL,
    "state" "PublishState" NOT NULL DEFAULT 'QUEUED',
    "external_ref" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "attachment_sent" BOOLEAN NOT NULL DEFAULT false,
    "action_proposal_id" TEXT,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "published_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "publishes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "folder_path" TEXT,
    "key_dates" JSONB,
    "expires_at" TIMESTAMP(3),
    "uploaded_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "owner_user_id" TEXT,
    "due_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "cadence" TEXT,
    "depends_on_task_id" TEXT,
    "ai_prefilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "recipient_user_id" TEXT,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB,
    "read_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_log" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "to_e164" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "delivery_state" TEXT,
    "cost_pence" INTEGER,
    "chase_id" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imports" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT,
    "mapping_ref" TEXT,
    "row_count" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "failure_message" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB,
    "s3_key" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "virus_scanned" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "seq" BIGINT NOT NULL,
    "previous_hash" TEXT,
    "hash" TEXT NOT NULL,
    "trace_id" TEXT,
    "correlation_id" TEXT,
    "actor_pseudonym" TEXT,
    "event" TEXT NOT NULL,
    "input_hash" TEXT,
    "input_pointer" TEXT,
    "model_id" TEXT,
    "prompt_version" TEXT,
    "proposal_id" TEXT,
    "payload_hash" TEXT,
    "rendered_summary_hash" TEXT,
    "outcome" JSONB,
    "latency_ms" INTEGER,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "owner" TEXT,
    "remove_by" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "businesses_practice_id_idx" ON "businesses"("practice_id");

-- CreateIndex
CREATE INDEX "businesses_practice_id_is_active_idx" ON "businesses"("practice_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_business_id_idx" ON "memberships"("business_id");

-- CreateIndex
CREATE INDEX "memberships_practice_id_idx" ON "memberships"("practice_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_business_id_key" ON "memberships"("user_id", "business_id");

-- CreateIndex
CREATE INDEX "contacts_business_id_idx" ON "contacts"("business_id");

-- CreateIndex
CREATE INDEX "contacts_mobile_e164_idx" ON "contacts"("mobile_e164");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_business_id_idx" ON "invites"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "otp_sessions_link_token_hash_key" ON "otp_sessions"("link_token_hash");

-- CreateIndex
CREATE INDEX "otp_sessions_business_id_idx" ON "otp_sessions"("business_id");

-- CreateIndex
CREATE INDEX "otp_sessions_chase_id_idx" ON "otp_sessions"("chase_id");

-- CreateIndex
CREATE INDEX "documents_business_id_inbox_state_idx" ON "documents"("business_id", "inbox", "state");

-- CreateIndex
CREATE INDEX "documents_business_id_received_at_idx" ON "documents"("business_id", "received_at");

-- CreateIndex
CREATE INDEX "documents_business_id_byte_hash_idx" ON "documents"("business_id", "byte_hash");

-- CreateIndex
CREATE INDEX "documents_business_id_supplier_name_document_date_idx" ON "documents"("business_id", "supplier_name", "document_date");

-- CreateIndex
CREATE INDEX "documents_parent_document_id_idx" ON "documents"("parent_document_id");

-- CreateIndex
CREATE INDEX "extractions_document_id_idx" ON "extractions"("document_id");

-- CreateIndex
CREATE INDEX "document_events_document_id_created_at_idx" ON "document_events"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "document_events_trace_id_idx" ON "document_events"("trace_id");

-- CreateIndex
CREATE INDEX "duplicates_business_id_verdict_idx" ON "duplicates"("business_id", "verdict");

-- CreateIndex
CREATE UNIQUE INDEX "duplicates_document_aid_document_bid_key" ON "duplicates"("document_aid", "document_bid");

-- CreateIndex
CREATE INDEX "rules_business_id_tier_is_active_idx" ON "rules"("business_id", "tier", "is_active");

-- CreateIndex
CREATE INDEX "rules_business_id_scope_key_idx" ON "rules"("business_id", "scope_key");

-- CreateIndex
CREATE INDEX "guidance_business_id_is_active_idx" ON "guidance"("business_id", "is_active");

-- CreateIndex
CREATE INDEX "guidance_practice_id_is_active_idx" ON "guidance"("practice_id", "is_active");

-- CreateIndex
CREATE INDEX "suggestions_document_id_field_idx" ON "suggestions"("document_id", "field");

-- CreateIndex
CREATE INDEX "bank_connections_business_id_consent_state_idx" ON "bank_connections"("business_id", "consent_state");

-- CreateIndex
CREATE INDEX "bank_accounts_business_id_idx" ON "bank_accounts"("business_id");

-- CreateIndex
CREATE INDEX "bank_transactions_business_id_match_state_idx" ON "bank_transactions"("business_id", "match_state");

-- CreateIndex
CREATE INDEX "bank_transactions_business_id_booked_at_idx" ON "bank_transactions"("business_id", "booked_at");

-- CreateIndex
CREATE INDEX "bank_transactions_account_id_booked_at_idx" ON "bank_transactions"("account_id", "booked_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_account_id_provider_transaction_id_key" ON "bank_transactions"("account_id", "provider_transaction_id");

-- CreateIndex
CREATE INDEX "statements_business_id_period_end_idx" ON "statements"("business_id", "period_end");

-- CreateIndex
CREATE INDEX "supplier_statements_business_id_supplier_name_idx" ON "supplier_statements"("business_id", "supplier_name");

-- CreateIndex
CREATE INDEX "supplier_statement_lines_supplier_statement_id_status_idx" ON "supplier_statement_lines"("supplier_statement_id", "status");

-- CreateIndex
CREATE INDEX "matches_business_id_state_idx" ON "matches"("business_id", "state");

-- CreateIndex
CREATE INDEX "matches_document_id_idx" ON "matches"("document_id");

-- CreateIndex
CREATE INDEX "matches_transaction_id_idx" ON "matches"("transaction_id");

-- CreateIndex
CREATE INDEX "chases_business_id_state_idx" ON "chases"("business_id", "state");

-- CreateIndex
CREATE INDEX "chases_business_id_created_at_idx" ON "chases"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "chase_messages_chase_id_idx" ON "chase_messages"("chase_id");

-- CreateIndex
CREATE INDEX "item_threads_document_id_idx" ON "item_threads"("document_id");

-- CreateIndex
CREATE INDEX "approval_workflows_business_id_is_active_idx" ON "approval_workflows"("business_id", "is_active");

-- CreateIndex
CREATE INDEX "approvals_document_id_idx" ON "approvals"("document_id");

-- CreateIndex
CREATE INDEX "action_proposals_business_id_state_idx" ON "action_proposals"("business_id", "state");

-- CreateIndex
CREATE INDEX "action_proposals_kind_state_idx" ON "action_proposals"("kind", "state");

-- CreateIndex
CREATE INDEX "action_proposals_trace_id_idx" ON "action_proposals"("trace_id");

-- CreateIndex
CREATE INDEX "integrations_business_id_is_active_idx" ON "integrations"("business_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_business_id_kind_key" ON "integrations"("business_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "reference_syncs_integration_id_list_kind_key" ON "reference_syncs"("integration_id", "list_kind");

-- CreateIndex
CREATE INDEX "publishes_business_id_state_idx" ON "publishes"("business_id", "state");

-- CreateIndex
CREATE INDEX "publishes_document_id_idx" ON "publishes"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishes_idempotency_key_key" ON "publishes"("idempotency_key");

-- CreateIndex
CREATE INDEX "vault_items_business_id_category_idx" ON "vault_items"("business_id", "category");

-- CreateIndex
CREATE INDEX "vault_items_business_id_expires_at_idx" ON "vault_items"("business_id", "expires_at");

-- CreateIndex
CREATE INDEX "tasks_business_id_status_idx" ON "tasks"("business_id", "status");

-- CreateIndex
CREATE INDEX "notifications_business_id_recipient_user_id_read_at_idx" ON "notifications"("business_id", "recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "sms_log_business_id_sent_at_idx" ON "sms_log"("business_id", "sent_at");

-- CreateIndex
CREATE INDEX "imports_business_id_state_idx" ON "imports"("business_id", "state");

-- CreateIndex
CREATE INDEX "exports_business_id_state_idx" ON "exports"("business_id", "state");

-- CreateIndex
CREATE INDEX "audit_events_business_id_created_at_idx" ON "audit_events"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_trace_id_idx" ON "audit_events"("trace_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_business_id_seq_key" ON "audit_events"("business_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_sessions" ADD CONSTRAINT "otp_sessions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_sessions" ADD CONSTRAINT "otp_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_sessions" ADD CONSTRAINT "otp_sessions_chase_id_fkey" FOREIGN KEY ("chase_id") REFERENCES "chases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_submitter_user_id_fkey" FOREIGN KEY ("submitter_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_document_id_fkey" FOREIGN KEY ("parent_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicates" ADD CONSTRAINT "duplicates_document_aid_fkey" FOREIGN KEY ("document_aid") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicates" ADD CONSTRAINT "duplicates_document_bid_fkey" FOREIGN KEY ("document_bid") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rules" ADD CONSTRAINT "rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "bank_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statements" ADD CONSTRAINT "statements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statements" ADD CONSTRAINT "statements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_statements" ADD CONSTRAINT "supplier_statements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_statement_lines" ADD CONSTRAINT "supplier_statement_lines_supplier_statement_id_fkey" FOREIGN KEY ("supplier_statement_id") REFERENCES "supplier_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "bank_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chases" ADD CONSTRAINT "chases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chases" ADD CONSTRAINT "chases_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chases" ADD CONSTRAINT "chases_recipient_contact_id_fkey" FOREIGN KEY ("recipient_contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chase_messages" ADD CONSTRAINT "chase_messages_chase_id_fkey" FOREIGN KEY ("chase_id") REFERENCES "chases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_threads" ADD CONSTRAINT "item_threads_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "approval_workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_syncs" ADD CONSTRAINT "reference_syncs_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== RLS policies appended from prisma/sql/rls.sql =====

-- NEOTING — row-level security policies (Sprint-0 contract, LAW per G7/D15)
--
-- Governance §5.2. This file is the tenancy guarantee. Prisma cannot express
-- RLS, so these statements are appended to the initial migration and every
-- migration that adds a tenant-owned table.
--
--   pnpm --filter @neoting/api exec prisma migrate dev --create-only --name init
--   cat prisma/sql/rls.sql >> prisma/migrations/<timestamp>_init/migration.sql
--   pnpm --filter @neoting/api exec prisma migrate dev
--
-- A migration that adds a tenant table without adding it to TENANT_TABLES below
-- is an incomplete migration and a review reject.

-- ===========================================================================
-- 0. THE ROLE SPLIT — without this, everything below is decorative
-- ===========================================================================
--
-- Postgres BYPASSES row-level security for the owner of a table. If the
-- application connects as the role that owns the schema, every policy in this
-- file is silently inert and the product has no tenancy isolation at all.
--
-- So: the migration role owns the schema, the application connects as nt_app,
-- and every tenant table is FORCE ROW LEVEL SECURITY (belt and braces — FORCE
-- makes policies apply even to the owner).
--
-- Run once per environment, as the migration/master role. Not part of the
-- Prisma migration because the password comes from Secrets Manager.
--
--   CREATE ROLE nt_app LOGIN PASSWORD '<from secrets manager>';
--   GRANT USAGE ON SCHEMA public TO nt_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nt_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nt_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT USAGE, SELECT ON SEQUENCES TO nt_app;
--
-- nt_app must NOT be SUPERUSER and must NOT have BYPASSRLS. The CI tenancy
-- suite (Governance §15.4) asserts both.

-- ===========================================================================
-- 1. Request context — set by scopedDb(ctx), read by every policy
-- ===========================================================================
--
-- scopedDb opens a transaction and runs SET LOCAL for each of these before any
-- query. SET LOCAL dies with the transaction, so context cannot leak between
-- pooled connections.

CREATE OR REPLACE FUNCTION app_actor_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.actor_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_practice_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.practice_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_business_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.business_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_session_scope() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT coalesce(nullif(current_setting('app.session_scope', true), ''), 'user') $$;

-- Comma-separated item ids granted to a delegated OTP session.
CREATE OR REPLACE FUNCTION app_granted_item_ids() RETURNS text[]
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT coalesce(
     string_to_array(nullif(current_setting('app.granted_item_ids', true), ''), ','),
     ARRAY[]::text[]
   ) $$;

-- ===========================================================================
-- 2. The access predicate
-- ===========================================================================
--
-- One function, used by every tenant policy, so the rule lives in exactly one
-- place. Three ways a row is visible:
--
--   a) it belongs to the business in scope;
--   b) the actor is practice staff and the business belongs to their practice,
--      AND they are assigned to it (or hold a practice-wide membership);
--   c) nothing else. Delegated OTP sessions are handled separately and
--      deliberately do NOT go through this function.
--
-- Note the explicit `app_session_scope() = 'user'` guard: a delegated portal
-- session must never widen into normal access, even if a handler forgets.

CREATE OR REPLACE FUNCTION app_can_access_business(target_business_id text)
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$
  SELECT
    target_business_id IS NOT NULL
    AND app_session_scope() = 'user'
    AND app_actor_id() IS NOT NULL
    AND (
      target_business_id = app_business_id()
      OR EXISTS (
        SELECT 1
        FROM memberships m
        WHERE m.user_id = app_actor_id()
          AND m.business_id = target_business_id
      )
      OR EXISTS (
        SELECT 1
        FROM memberships m
        JOIN businesses b ON b.id = target_business_id
        WHERE m.user_id = app_actor_id()
          AND m.practice_id IS NOT NULL
          AND m.practice_id = b.practice_id
      )
    )
$$;

-- ===========================================================================
-- 3. Enable RLS on every tenant-owned table
-- ===========================================================================
--
-- ADD NEW TENANT TABLES HERE. The loop is deliberate: 30+ hand-written policy
-- blocks drift, and a drifted policy is a silent tenancy hole.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'businesses', 'contacts', 'invites', 'otp_sessions',
    'documents', 'extractions', 'document_events', 'duplicates',
    'rules', 'guidance', 'suggestions',
    'bank_connections', 'bank_accounts', 'bank_transactions', 'statements',
    'supplier_statements', 'supplier_statement_lines', 'matches',
    'chases', 'chase_messages', 'item_threads',
    'approval_workflows', 'approvals', 'action_proposals',
    'integrations', 'reference_syncs', 'publishes',
    'vault_items', 'tasks', 'notifications', 'sms_log',
    'imports', 'exports', 'audit_events'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the policy applies even to the table owner. This is the line
    -- that stops a migration-role connection from seeing everything.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- --- tables that carry business_id directly ------------------------------
DO $$
DECLARE
  t text;
  direct_tables text[] := ARRAY[
    'contacts', 'otp_sessions', 'documents', 'duplicates',
    'rules', 'bank_connections', 'bank_accounts', 'bank_transactions',
    'statements', 'supplier_statements', 'matches', 'chases',
    'approval_workflows', 'integrations', 'publishes',
    'vault_items', 'tasks', 'notifications', 'sms_log', 'imports', 'exports'
  ];
BEGIN
  FOREACH t IN ARRAY direct_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_can_access_business(business_id))
       WITH CHECK (app_can_access_business(business_id))',
      t || '_tenant', t
    );
  END LOOP;
END $$;

-- --- businesses: the row is its own tenant -------------------------------
--
-- This policy is deliberately written out rather than calling
-- app_can_access_business(). That function reads `businesses` to find a row's
-- practice, so using it here would make the businesses policy call a function
-- that queries businesses, which re-enters the policy — Postgres recurses until
-- `stack depth limit exceeded`. Written this way it touches only the row's own
-- columns and `memberships`, which carries no RLS, so the cycle cannot form.
--
-- Everything else may safely use the function: their policies do not call it.
DROP POLICY IF EXISTS businesses_tenant ON businesses;
CREATE POLICY businesses_tenant ON businesses
  USING (
    app_session_scope() = 'user'
    AND app_actor_id() IS NOT NULL
    AND (
      id = app_business_id()
      OR EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.user_id = app_actor_id() AND m.business_id = businesses.id
      )
      OR (
        practice_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.user_id = app_actor_id() AND m.practice_id = businesses.practice_id
        )
      )
    )
  )
  WITH CHECK (
    app_session_scope() = 'user'
    AND app_actor_id() IS NOT NULL
    AND (
      id = app_business_id()
      OR EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.user_id = app_actor_id() AND m.business_id = businesses.id
      )
      OR (
        practice_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.user_id = app_actor_id() AND m.practice_id = businesses.practice_id
        )
      )
    )
  );

-- --- child tables: reached through their parent ---------------------------
DROP POLICY IF EXISTS extractions_tenant ON extractions;
CREATE POLICY extractions_tenant ON extractions
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)));

DROP POLICY IF EXISTS document_events_tenant ON document_events;
CREATE POLICY document_events_tenant ON document_events
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)));

DROP POLICY IF EXISTS suggestions_tenant ON suggestions;
CREATE POLICY suggestions_tenant ON suggestions
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)));

DROP POLICY IF EXISTS item_threads_tenant ON item_threads;
CREATE POLICY item_threads_tenant ON item_threads
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)));

DROP POLICY IF EXISTS approvals_tenant ON approvals;
CREATE POLICY approvals_tenant ON approvals
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_business(d.business_id)));

DROP POLICY IF EXISTS chase_messages_tenant ON chase_messages;
CREATE POLICY chase_messages_tenant ON chase_messages
  USING (EXISTS (SELECT 1 FROM chases c WHERE c.id = chase_id AND app_can_access_business(c.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM chases c WHERE c.id = chase_id AND app_can_access_business(c.business_id)));

DROP POLICY IF EXISTS supplier_statement_lines_tenant ON supplier_statement_lines;
CREATE POLICY supplier_statement_lines_tenant ON supplier_statement_lines
  USING (EXISTS (SELECT 1 FROM supplier_statements s WHERE s.id = supplier_statement_id AND app_can_access_business(s.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM supplier_statements s WHERE s.id = supplier_statement_id AND app_can_access_business(s.business_id)));

DROP POLICY IF EXISTS reference_syncs_tenant ON reference_syncs;
CREATE POLICY reference_syncs_tenant ON reference_syncs
  USING (EXISTS (SELECT 1 FROM integrations i WHERE i.id = integration_id AND app_can_access_business(i.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM integrations i WHERE i.id = integration_id AND app_can_access_business(i.business_id)));

-- --- nullable business_id: practice-level rows ----------------------------
DROP POLICY IF EXISTS invites_tenant ON invites;
CREATE POLICY invites_tenant ON invites
  USING (
    (business_id IS NOT NULL AND app_can_access_business(business_id))
    OR (business_id IS NULL AND practice_id IS NOT NULL AND practice_id = app_practice_id())
  )
  WITH CHECK (
    (business_id IS NOT NULL AND app_can_access_business(business_id))
    OR (business_id IS NULL AND practice_id IS NOT NULL AND practice_id = app_practice_id())
  );

DROP POLICY IF EXISTS guidance_tenant ON guidance;
CREATE POLICY guidance_tenant ON guidance
  USING (
    (business_id IS NOT NULL AND app_can_access_business(business_id))
    OR (business_id IS NULL AND practice_id IS NOT NULL AND practice_id = app_practice_id())
  )
  WITH CHECK (
    (business_id IS NOT NULL AND app_can_access_business(business_id))
    OR (business_id IS NULL AND practice_id IS NOT NULL AND practice_id = app_practice_id())
  );

-- ===========================================================================
-- 4. Delegated OTP sessions — scoped to exactly the granted items
-- ===========================================================================
--
-- SoT Stage 8.3: the secure link is deliberately forwardable to whoever
-- physically holds the document. That makes the scope restriction load-bearing
-- rather than incidental — anyone holding the link gets exactly the requested
-- items and nothing else, no matter what the handler asks for.
--
-- Separate PERMISSIVE policies: a delegated session fails
-- app_can_access_business() (which requires scope 'user'), so these are the
-- only route in for it.

DROP POLICY IF EXISTS documents_delegated_upload ON documents;
CREATE POLICY documents_delegated_upload ON documents
  USING (
    app_session_scope() = 'delegated_upload'
    AND id = ANY(app_granted_item_ids())
  )
  WITH CHECK (
    app_session_scope() = 'delegated_upload'
    AND business_id = app_business_id()
  );

DROP POLICY IF EXISTS extractions_delegated_upload ON extractions;
CREATE POLICY extractions_delegated_upload ON extractions
  USING (
    app_session_scope() = 'delegated_upload'
    AND document_id = ANY(app_granted_item_ids())
  )
  WITH CHECK (
    app_session_scope() = 'delegated_upload'
    AND document_id = ANY(app_granted_item_ids())
  );

-- ===========================================================================
-- 5. Append-only audit stream
-- ===========================================================================
--
-- Governance §12.3: append-only, hash-chained, no update or delete API exists.
-- Enforced here as well as in the service, because "the service is the only
-- writer" is a convention and this is a guarantee.

DROP POLICY IF EXISTS audit_events_read ON audit_events;
CREATE POLICY audit_events_read ON audit_events
  FOR SELECT
  USING (business_id IS NULL OR app_can_access_business(business_id));

DROP POLICY IF EXISTS audit_events_append ON audit_events;
CREATE POLICY audit_events_append ON audit_events
  FOR INSERT
  WITH CHECK (business_id IS NULL OR app_can_access_business(business_id));

-- No UPDATE or DELETE policy exists, so both are denied by default. Belt and
-- braces with a trigger, because a future migration might add one by accident.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (Governance §12.3)';
END $$;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- ===========================================================================
-- 6. Action proposals — the Review → Approve spine
-- ===========================================================================
--
-- Governance §10.4: execution consumes a proposal exactly once. A proposal that
-- has been executed can never be re-approved or re-executed, and approval
-- cannot precede review. Enforced in the database so that no code path — including
-- one written next year by someone who has not read §10 — can bypass it.

DROP POLICY IF EXISTS action_proposals_tenant ON action_proposals;
CREATE POLICY action_proposals_tenant ON action_proposals
  USING (business_id IS NULL OR app_can_access_business(business_id))
  WITH CHECK (business_id IS NULL OR app_can_access_business(business_id));

CREATE OR REPLACE FUNCTION action_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  -- Execution consumes the proposal exactly once, so an executed proposal is
  -- terminal — no further UPDATE of any kind. Comparing timestamps is not
  -- enough: now() is stable within a transaction, so a repeated execution
  -- writes an identical value and slips past an IS DISTINCT FROM check.
  IF OLD.executed_at IS NOT NULL THEN
    RAISE EXCEPTION 'action proposal % already executed and is immutable (Governance §10.4)', OLD.id;
  END IF;

  IF NEW.approved_at IS NOT NULL AND NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'action proposal % approved without review (Governance §10.3)', OLD.id;
  END IF;

  IF OLD.payload_hash IS DISTINCT FROM NEW.payload_hash THEN
    RAISE EXCEPTION 'action proposal % payload changed after creation (Governance §10.4)', OLD.id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS action_proposals_guard_trigger ON action_proposals;
CREATE TRIGGER action_proposals_guard_trigger
  BEFORE UPDATE ON action_proposals
  FOR EACH ROW EXECUTE FUNCTION action_proposals_guard();

-- ===========================================================================
-- 7. Performance note
-- ===========================================================================
--
-- app_can_access_business() runs an EXISTS against memberships per row. The
-- indexes below make it an index probe rather than a scan. If a practice-wide
-- dashboard query ever exceeds the 100ms p95 budget (Governance §5.1), the fix
-- is a materialised accessible-business set refreshed on membership change —
-- NOT loosening the policy.

CREATE INDEX IF NOT EXISTS memberships_user_business_idx ON memberships (user_id, business_id);
CREATE INDEX IF NOT EXISTS memberships_user_practice_idx ON memberships (user_id, practice_id);
