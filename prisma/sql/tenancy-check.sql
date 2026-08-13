-- Tenancy smoke test — the miniature of the CI suite (Governance §15.4).
--
-- Run against a freshly migrated database:
--   docker exec -i nt-postgres psql -U neoting -d neoting -v ON_ERROR_STOP=1 \
--     < prisma/sql/tenancy-check.sql
--
-- Every assertion below must pass. A failure here means the tenancy guarantee
-- is not real, whatever the policies look like.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- setup ---
-- nt_app is the role the application connects as: NOT the schema owner, NOT a
-- superuser, NO BYPASSRLS. That combination is what makes the policies bite.
DROP ROLE IF EXISTS nt_app;
CREATE ROLE nt_app LOGIN PASSWORD 'nt_app_local';
GRANT USAGE ON SCHEMA public TO nt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nt_app;

-- Seeded as superuser, which bypasses RLS. Note this on purpose: initial
-- provisioning cannot run under these policies, because app_can_access_business
-- needs a membership that does not exist until provisioning finishes.
TRUNCATE practices, businesses, users, memberships, documents, otp_sessions,
         action_proposals, audit_events CASCADE;

INSERT INTO practices (id, name, updated_at) VALUES
  ('prac_a', 'Practice A', now()),
  ('prac_b', 'Practice B', now());

INSERT INTO businesses (id, practice_id, name, updated_at) VALUES
  ('biz_a1', 'prac_a', 'Client A1', now()),
  ('biz_a2', 'prac_a', 'Client A2', now()),
  ('biz_b1', 'prac_b', 'Client B1', now());

INSERT INTO users (id, email, updated_at) VALUES
  ('user_a', 'a@example.test', now()),
  ('user_b', 'b@example.test', now()),
  ('user_client', 'c@example.test', now());

INSERT INTO memberships (id, user_id, practice_id, business_id, role, updated_at) VALUES
  ('mem_a', 'user_a', 'prac_a', NULL,     'PRACTICE_ADMIN', now()),
  ('mem_b', 'user_b', 'prac_b', NULL,     'PRACTICE_ADMIN', now()),
  ('mem_c', 'user_client', NULL, 'biz_a1', 'BUSINESS_ADMIN', now());

INSERT INTO documents (id, business_id, s3_key, original_filename, mime_type,
                       byte_size, byte_hash, channel, updated_at) VALUES
  ('doc_a1_1', 'biz_a1', 'k1', 'a1-one.pdf',  'application/pdf', 10, 'h1', 'WEB_UPLOAD', now()),
  ('doc_a1_2', 'biz_a1', 'k2', 'a1-two.pdf',  'application/pdf', 10, 'h2', 'WEB_UPLOAD', now()),
  ('doc_a2_1', 'biz_a2', 'k3', 'a2-one.pdf',  'application/pdf', 10, 'h3', 'WEB_UPLOAD', now()),
  ('doc_b1_1', 'biz_b1', 'k4', 'b1-one.pdf',  'application/pdf', 10, 'h4', 'WEB_UPLOAD', now());

-- ----------------------------------------------------------- assertions ---
CREATE OR REPLACE FUNCTION assert_eq(actual bigint, expected bigint, label text)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'pass: % (%)', label, actual;
END $$;

-- === 1. the role itself ====================================================
DO $$
DECLARE su boolean; brls boolean;
BEGIN
  SELECT rolsuper, rolbypassrls INTO su, brls FROM pg_roles WHERE rolname = 'nt_app';
  IF su THEN RAISE EXCEPTION 'FAIL: nt_app is a superuser — RLS would be bypassed entirely'; END IF;
  IF brls THEN RAISE EXCEPTION 'FAIL: nt_app has BYPASSRLS'; END IF;
  RAISE NOTICE 'pass: nt_app is neither superuser nor BYPASSRLS';
END $$;

-- === 2. practice staff see their own practice's clients ====================
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 'user_a';
  SET LOCAL app.practice_id = 'prac_a';
  SET LOCAL app.session_scope = 'user';

  SELECT assert_eq(count(*), 3, 'practice A sees its own 3 documents') FROM documents;
  SELECT assert_eq(count(*), 0, 'practice A sees no practice B documents')
    FROM documents WHERE business_id = 'biz_b1';
  SELECT assert_eq(count(*), 2, 'practice A sees its own 2 businesses') FROM businesses;
COMMIT;

-- === 3. cross-practice reads are blocked ===================================
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 'user_b';
  SET LOCAL app.practice_id = 'prac_b';
  SET LOCAL app.session_scope = 'user';

  SELECT assert_eq(count(*), 1, 'practice B sees only its own document') FROM documents;
  SELECT assert_eq(count(*), 0, 'practice B cannot see practice A documents')
    FROM documents WHERE business_id LIKE 'biz_a%';
COMMIT;

-- === 4. a client user sees only their own workspace ========================
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 'user_client';
  SET LOCAL app.business_id = 'biz_a1';
  SET LOCAL app.session_scope = 'user';

  SELECT assert_eq(count(*), 2, 'client user sees only biz_a1 documents') FROM documents;
  SELECT assert_eq(count(*), 0, 'client user cannot see sibling client biz_a2')
    FROM documents WHERE business_id = 'biz_a2';
COMMIT;

-- === 5. delegated OTP session is scoped to granted items only ==============
-- The chase link is deliberately forwardable, so this restriction is
-- load-bearing rather than incidental (SoT Stage 8.3).
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 'user_client';
  SET LOCAL app.business_id = 'biz_a1';
  SET LOCAL app.session_scope = 'delegated_upload';
  SET LOCAL app.granted_item_ids = 'doc_a1_1';

  SELECT assert_eq(count(*), 1, 'delegated session sees exactly its granted item') FROM documents;
  SELECT assert_eq(count(*), 0, 'delegated session cannot see the other document in the same business')
    FROM documents WHERE id = 'doc_a1_2';
  SELECT assert_eq(count(*), 0, 'delegated session cannot see other businesses') FROM businesses;
COMMIT;

-- === 6. no context means no rows ===========================================
BEGIN;
  SET LOCAL ROLE nt_app;
  SELECT assert_eq(count(*), 0, 'no session context sees nothing') FROM documents;
COMMIT;

-- === 7. audit_events is append-only ========================================
INSERT INTO audit_events (id, business_id, seq, hash, event)
  VALUES ('aud_1', 'biz_a1', 1, 'h', 'test.event');

DO $$
BEGIN
  BEGIN
    UPDATE audit_events SET event = 'tampered' WHERE id = 'aud_1';
    RAISE EXCEPTION 'FAIL: audit_events accepted an UPDATE';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: audit_events rejected UPDATE (%)', sqlerrm;
  END;

  BEGIN
    DELETE FROM audit_events WHERE id = 'aud_1';
    RAISE EXCEPTION 'FAIL: audit_events accepted a DELETE';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: audit_events rejected DELETE (%)', sqlerrm;
  END;
END $$;

-- === 8. the Review → Approve guard =========================================
INSERT INTO action_proposals (id, business_id, kind, payload, payload_hash, expires_at)
  VALUES ('prop_1', 'biz_a1', 'chase-send', '{}'::jsonb, 'ph1', now() + interval '1 hour');

DO $$
BEGIN
  -- approve without review
  BEGIN
    UPDATE action_proposals SET approved_at = now(), state = 'APPROVED' WHERE id = 'prop_1';
    RAISE EXCEPTION 'FAIL: proposal approved without review';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: approval without review rejected (%)', sqlerrm;
  END;

  -- payload cannot change after creation
  BEGIN
    UPDATE action_proposals SET payload_hash = 'tampered' WHERE id = 'prop_1';
    RAISE EXCEPTION 'FAIL: proposal payload_hash was allowed to change';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: payload_hash change rejected (%)', sqlerrm;
  END;

  -- the legitimate path: review, then approve, then execute
  UPDATE action_proposals SET reviewed_at = now(), state = 'REVIEWED' WHERE id = 'prop_1';
  UPDATE action_proposals SET approved_at = now(), state = 'APPROVED' WHERE id = 'prop_1';
  UPDATE action_proposals SET executed_at = now(), state = 'EXECUTED' WHERE id = 'prop_1';
  RAISE NOTICE 'pass: review -> approve -> execute accepted';

  -- and is terminal afterwards: no further update of any kind, including one
  -- that writes an identical timestamp (now() is stable within a transaction)
  BEGIN
    UPDATE action_proposals SET executed_at = now() WHERE id = 'prop_1';
    RAISE EXCEPTION 'FAIL: proposal executed twice';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: second execution rejected (%)', sqlerrm;
  END;
END $$;

\echo ''
\echo '================================================'
\echo ' TENANCY CHECK PASSED'
\echo '================================================'
