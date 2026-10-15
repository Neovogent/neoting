-- AlterEnum
ALTER TYPE "UserKind" ADD VALUE 'API';

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_by_id" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret_sealed" TEXT NOT NULL,
    "events" TEXT[],
    "disabled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "business_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fanned_out_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_code" INTEGER,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_webhooks" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url_sealed" TEXT NOT NULL,
    "url_hint" TEXT NOT NULL,
    "events" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_actor_user_id_key" ON "api_keys"("actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_token_hash_key" ON "api_keys"("token_hash");

-- CreateIndex
CREATE INDEX "api_keys_practice_id_idx" ON "api_keys"("practice_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_practice_id_idx" ON "webhook_endpoints"("practice_id");

-- CreateIndex
CREATE INDEX "webhook_events_practice_id_fanned_out_at_idx" ON "webhook_events"("practice_id", "fanned_out_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "push_subscriptions_practice_id_user_id_idx" ON "push_subscriptions"("practice_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_practice_id_endpoint_key" ON "push_subscriptions"("practice_id", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "chat_webhooks_practice_id_kind_key" ON "chat_webhooks"("practice_id", "kind");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS — the same block is appended to prisma/sql/rls.sql (`rush/public-api`).
--
-- Practice-level tables use the anchor-pair predicate with a NULL business —
-- the `teams` shape — so a delegated portal session can never read them.
-- `webhook_events` is written inside whatever transaction caused the event,
-- including a client-scoped one, so it takes the business branch too.
-- `webhook_deliveries` is reached through its endpoint (the chase_messages shape).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'webhook_endpoints', 'webhook_events', 'webhook_deliveries', 'push_subscriptions', 'chat_webhooks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['api_keys', 'webhook_endpoints', 'push_subscriptions', 'chat_webhooks'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_can_access_document(NULL::text, practice_id)) WITH CHECK (app_can_access_document(NULL::text, practice_id))',
      t || '_tenant', t
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS webhook_events_tenant ON webhook_events;
CREATE POLICY webhook_events_tenant ON webhook_events
  USING (app_can_access_document(business_id, practice_id))
  WITH CHECK (app_can_access_document(business_id, practice_id));

DROP POLICY IF EXISTS webhook_deliveries_tenant ON webhook_deliveries;
CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries
  USING (EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.id = endpoint_id AND app_can_access_document(NULL::text, e.practice_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.id = endpoint_id AND app_can_access_document(NULL::text, e.practice_id)));
