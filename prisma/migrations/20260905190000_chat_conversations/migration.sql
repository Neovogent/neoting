-- chat_conversations — a practice member's saved workspace-chat transcript
-- (review item 9, 5 Sep 2026: "full regular task and chat system"; a
-- conversation that evaporates on reload is not a system).
--
-- ADDITIVE ONLY: one new table, no existing table touched, no data written.
-- Reversible in one DROP TABLE.
--
-- Shape notes (the schema.prisma doc comment carries the full argument):
--   * messages is ONE JSONB column, not a second table — a transcript is read
--     and replaced whole (PUT upsert, capped at 200 messages in the contract),
--     and a message table would need its own RLS policy for rows carrying no
--     tenant column.
--   * (practice_id, created_by_user_id, client_key) is the caller-facing
--     identity: the id in the URL is the CLIENT's own name for the
--     conversation, namespaced per practice member, so it carries no
--     cross-tenant authority.
--   * business_id is nullable (a conversation with no client attached), which
--     is why the RLS policy below is the otp_sessions anchor-pair shape and
--     not the single-column loop predicate.

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL,
    "practice_id" TEXT NOT NULL,
    "business_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_conversations_practice_id_created_by_user_id_client_ke_key" ON "chat_conversations"("practice_id", "created_by_user_id", "client_key");

-- CreateIndex
CREATE INDEX "chat_conversations_practice_id_created_by_user_id_updated_a_idx" ON "chat_conversations"("practice_id", "created_by_user_id", "updated_at");

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- prisma/sql/rls.sql, re-appended in full below, as every migration that
-- touches RLS does — the new table joins the FORCE-RLS list and gains the
-- anchor-pair policy.
-- ===========================================================================
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
    'imports', 'exports', 'audit_events',
    'document_links', 'chat_conversations'
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
  -- `documents` is NOT here. Its business_id is nullable (an Unrouted document
  -- has no business yet, issue #17), so it needs the two-branch policy written
  -- out below rather than the single business_id predicate this loop applies.
  --
  -- `otp_sessions` LEFT this list in the ID LAW batch, for the same reason.
  -- ONBOARDING sessions (D47) have a practice and no business yet, and
  -- app_can_access_business(NULL) is FALSE — so under this loop's single-column
  -- predicate a NULL-business row would have been invisible AND unwritable to
  -- everyone, forever, with nothing reporting it. Its two-branch policy is
  -- written out below beside invites and guidance.
  direct_tables text[] := ARRAY[
    'contacts', 'duplicates',
    'rules', 'bank_connections', 'bank_accounts', 'bank_transactions',
    'statements', 'supplier_statements', 'matches', 'chases',
    'approval_workflows', 'integrations', 'publishes',
    'vault_items', 'tasks', 'notifications', 'sms_log', 'imports', 'exports',
    'document_links'
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

-- --- documents: business when known, practice until then ------------------
--
-- Issue #17. A document's `inbox` defaults to UNROUTED, which is the honest
-- statement that we do not yet know whose document it is. `business_id` is
-- therefore nullable, and tenancy falls back to the practice that received it.
--
-- Same two-branch shape as invites_tenant / guidance_tenant below. The
-- CHECK constraint `documents_tenant_anchor` guarantees at least one of the two
-- columns is present, so there is no third case where a row is owned by nobody
-- and visible to nobody — which would be a document lost in plain sight.
CREATE OR REPLACE FUNCTION app_can_access_document(
  target_business_id text, target_practice_id text
) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$
  SELECT
    (target_business_id IS NOT NULL AND app_can_access_business(target_business_id))
    OR (
      target_business_id IS NULL
      AND target_practice_id IS NOT NULL
      AND app_session_scope() = 'user'
      AND app_actor_id() IS NOT NULL
      AND target_practice_id = app_practice_id()
    )
$$;

DROP POLICY IF EXISTS documents_tenant ON documents;
CREATE POLICY documents_tenant ON documents
  USING (app_can_access_document(business_id, practice_id))
  WITH CHECK (app_can_access_document(business_id, practice_id));

-- --- child tables: reached through their parent ---------------------------
--
-- These reach their tenant THROUGH documents, so every one of them had to
-- change when documents.business_id became nullable: a predicate of the form
-- `app_can_access_business(d.business_id)` returns NULL — not true — for an
-- Unrouted document, which would make its extractions, events, suggestions,
-- threads and approvals invisible to the very practice staff whose job is to
-- route it. Silent, and it would have looked like a UI bug for weeks.
DROP POLICY IF EXISTS extractions_tenant ON extractions;
CREATE POLICY extractions_tenant ON extractions
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)));

DROP POLICY IF EXISTS document_events_tenant ON document_events;
CREATE POLICY document_events_tenant ON document_events
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)));

DROP POLICY IF EXISTS suggestions_tenant ON suggestions;
CREATE POLICY suggestions_tenant ON suggestions
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)));

DROP POLICY IF EXISTS item_threads_tenant ON item_threads;
CREATE POLICY item_threads_tenant ON item_threads
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)));

DROP POLICY IF EXISTS approvals_tenant ON approvals;
CREATE POLICY approvals_tenant ON approvals
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_can_access_document(d.business_id, d.practice_id)));

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

-- otp_sessions: business when a client is known, practice until then.
--
-- Uses app_can_access_document() — which despite its name is the anchor-pair
-- predicate, and is preferred here over the invites/guidance shape above
-- because it carries the `app_session_scope() = 'user' AND app_actor_id() IS
-- NOT NULL` guards that those two spell out only inside
-- app_can_access_business(). A delegated portal session must never be able to
-- read the session rows of its own or any other business.
DROP POLICY IF EXISTS otp_sessions_tenant ON otp_sessions;
CREATE POLICY otp_sessions_tenant ON otp_sessions
  USING (app_can_access_document(business_id, practice_id))
  WITH CHECK (app_can_access_document(business_id, practice_id));

-- chat_conversations: a practice member's saved chat transcript (review item 9,
-- 5 Sep 2026). The otp_sessions shape for the otp_sessions reason: business_id
-- is nullable (a conversation with no client attached has a practice above it
-- and no business), so the single-column loop predicate would strand every
-- unscoped conversation. The anchor-pair predicate also carries the
-- `app_session_scope() = 'user'` guard, so a delegated portal session can never
-- read an accountant's transcripts. WHO within the practice may see a row is
-- narrower than this policy — every query filters `created_by_user_id` — and
-- that is an application guarantee the service states, not one SQL makes.
DROP POLICY IF EXISTS chat_conversations_tenant ON chat_conversations;
CREATE POLICY chat_conversations_tenant ON chat_conversations
  USING (app_can_access_document(business_id, practice_id))
  WITH CHECK (app_can_access_document(business_id, practice_id));

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
    -- Added with issue #17, and it changes nothing that was previously
    -- possible: before business_id became nullable, every document had one, so
    -- this predicate was implicitly true for every row. Now that UNROUTED
    -- documents exist, the WITH CHECK below (business_id = app_business_id())
    -- still stops a delegated session WRITING one, but without this line it
    -- could READ one that found its way into a grant. Grants are minted from
    -- chases, and a chase is business-scoped, so that cannot happen today —
    -- which is a convention, and this file's whole argument is that a
    -- convention is not a guarantee.
    AND business_id IS NOT NULL
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
-- 4b. Capability URLs — the ONE route with no session at all (D43)
-- ===========================================================================
--
-- `GET /d/{code}` is unauthenticated BY DESIGN. An accountant reads the code
-- out of a CSV column inside VT Transaction+, where no session of ours can
-- exist, and reaches the source document (SoT §24.3.2). The code IS the
-- authorisation: unguessable, per-document, view-only, revocable, rate-limited.
--
-- That creates a genuine ordering problem this file has to answer rather than
-- route around. To resolve a code we need the row; to read the row under RLS we
-- need a practice-scoped actor; and the practice is precisely what the row would
-- have told us. Every policy branch begins `app_actor_id() IS NOT NULL`, so the
-- lookup cannot happen inside a scope context at all.
--
-- THREE OPTIONS WERE ON THE TABLE. The two that were rejected are recorded,
-- because "why is there a SECURITY DEFINER here when prisma/CLAUDE.md argues
-- against them" is a fair question and it deserves a written answer.
--
--   1. Leave `document_links` unpoliced, like `users` and `sessions`.
--      Rejected: it makes an entire tenant-owned table readable by any code
--      path that forgets to think, to spare one caller. The CI grep for
--      unscoped queries stops meaning anything on this table.
--
--   2. A third session scope, `capability_link`, with a policy branch keyed on
--      the code. Attractive — no bypass at all — but ScopeContext requires an
--      actorId AND a practice-or-business, and a capability read has none of
--      the three. Relaxing those two refinements weakens a shared guard for
--      EVERY caller in the system to serve one route. Rejected for that reason,
--      not because a third scope is unthinkable.
--
--   3. This: one narrow SECURITY DEFINER function that takes a code and returns
--      at most one row of four opaque ids plus two booleans. It reads no
--      financial data, it cannot be made to return more than one row (the code
--      is UNIQUE), and it is the whole bypass. Everything after it — the
--      document read, the audit write, the access-count update — goes through
--      scopedDb(systemContext(practiceId, systemUserId)) like any worker.
--
-- ⚠ `SET search_path` is not optional on a SECURITY DEFINER function. Without
-- it, anyone who can create a schema on the search path can shadow `businesses`
-- and have the function read their table as the owner. That is THE classic
-- SECURITY DEFINER exploit and the pin below is what closes it.
--
-- Deliberately left executable by PUBLIC, consistent with every other helper in
-- this file. "PUBLIC" here is exactly the two roles that can connect — the
-- migration owner, which already bypasses RLS, and nt_app. A REVOKE plus an
-- explicit GRANT would add a role-creation ordering dependency to every
-- environment (`db:reset` creates nt_app AFTER migrating) whose failure mode is
-- a production 500 on a route we would rather have working.
--
-- Revoked and expired links are returned WITH their state rather than hidden,
-- so `/d/{code}` can answer 410 Gone instead of 404. That does confirm a code
-- once existed — acceptable, because the code is CSPRNG-generated and rate
-- limited, and because an accountant holding a dead link in their ledger needs
-- to be told it was revoked rather than left to think they mistyped it.

CREATE OR REPLACE FUNCTION app_resolve_document_link(target_code text)
  RETURNS TABLE (
    link_id     text,
    document_id text,
    business_id text,
    practice_id text,
    revoked     boolean,
    expired     boolean
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $fn$
  SELECT
    dl.id,
    dl.document_id,
    dl.business_id,
    b.practice_id,
    dl.revoked_at IS NOT NULL,
    dl.expires_at IS NOT NULL AND dl.expires_at <= now()
  FROM document_links dl
  JOIN businesses b ON b.id = dl.business_id
  WHERE dl.code = target_code
$fn$;

COMMENT ON FUNCTION app_resolve_document_link(text) IS
  'D43 capability-URL resolver. The ONLY sanctioned RLS bypass in this schema. Returns ids and link state only, never document content; the caller must re-enter through scopedDb(systemContext(...)) to read anything.';

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

-- Anchored like documents (issue #104): business branch first, else a
-- NULL-business proposal is visible only to `user`-scope actors of its own
-- practice. The previous policy read `business_id IS NULL OR …`, which made a
-- NULL-business row world-readable AND world-writable — and NULL business is
-- the DEFAULT for `document.route`, whose subject is an unrouted document.
-- `action_proposals_tenant_anchor` (at-least-one CHECK, same shape and same
-- OR-not-exactly-one semantics as documents_tenant_anchor) guarantees the
-- predicate always has something to bite on.
DROP POLICY IF EXISTS action_proposals_tenant ON action_proposals;
CREATE POLICY action_proposals_tenant ON action_proposals
  USING (app_can_access_document(business_id, practice_id))
  WITH CHECK (app_can_access_document(business_id, practice_id));

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
