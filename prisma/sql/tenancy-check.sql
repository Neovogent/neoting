-- Tenancy smoke test — the miniature of the CI suite (Governance §15.4).
--
--   pnpm db:tenancy-check
--
-- NON-DESTRUCTIVE. It creates its own rows under a `t_` prefix, asserts against
-- only those rows, and removes them again — so it can be run against a seeded
-- database without destroying anyone's demo data. Assertions are scoped rather
-- than counted globally for exactly that reason.
--
-- Every assertion must pass. A failure here means the tenancy guarantee is not
-- real, whatever the policies look like.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- setup ---
-- nt_app is the role the application connects as: NOT the schema owner, NOT a
-- superuser, NO BYPASSRLS. That combination is what makes the policies bite.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nt_app') THEN
    CREATE ROLE nt_app LOGIN PASSWORD 'nt_app_local';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO nt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nt_app;

-- Clean up any previous run, oldest-dependency-last.
--
-- audit_events needs its own guard disabled to remove the probe row: the
-- append-only trigger blocks DELETE, which is exactly the behaviour asserted
-- below. The harness bypasses it on purpose and only as superuser — nothing in
-- the application can, and nothing in the application should ever do this.
ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
DELETE FROM audit_events WHERE id LIKE 't\_%';
ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;

DELETE FROM action_proposals WHERE id LIKE 't\_%';
DELETE FROM documents        WHERE id LIKE 't\_%';
DELETE FROM memberships      WHERE id LIKE 't\_%';
DELETE FROM users            WHERE id LIKE 't\_%';
DELETE FROM businesses       WHERE id LIKE 't\_%';
DELETE FROM practices        WHERE id LIKE 't\_%';

-- Seeded as superuser, which bypasses RLS. Worth noting deliberately: initial
-- provisioning cannot run under these policies either, because
-- app_can_access_business needs a membership that does not exist until
-- provisioning has finished creating it (see prisma/CLAUDE.md).
INSERT INTO practices (id, name, updated_at) VALUES
  ('t_prac_a', 'Test Practice A', now()),
  ('t_prac_b', 'Test Practice B', now());

INSERT INTO businesses (id, practice_id, name, updated_at) VALUES
  ('t_biz_a1', 't_prac_a', 'Test Client A1', now()),
  ('t_biz_a2', 't_prac_a', 'Test Client A2', now()),
  ('t_biz_b1', 't_prac_b', 'Test Client B1', now());

INSERT INTO users (id, email, updated_at) VALUES
  ('t_user_a',      'ta@example.test', now()),
  ('t_user_b',      'tb@example.test', now()),
  ('t_user_client', 'tc@example.test', now());

INSERT INTO memberships (id, user_id, practice_id, business_id, role, updated_at) VALUES
  ('t_mem_a', 't_user_a',      't_prac_a', NULL,       'PRACTICE_ADMIN', now()),
  ('t_mem_b', 't_user_b',      't_prac_b', NULL,       'PRACTICE_ADMIN', now()),
  ('t_mem_c', 't_user_client', NULL,       't_biz_a1', 'BUSINESS_ADMIN', now());

INSERT INTO documents (id, business_id, s3_key, original_filename, mime_type,
                       byte_size, byte_hash, channel, updated_at) VALUES
  ('t_doc_a1_1', 't_biz_a1', 'k1', 'a1-one.pdf', 'application/pdf', 10, 't_h1', 'WEB_UPLOAD', now()),
  ('t_doc_a1_2', 't_biz_a1', 'k2', 'a1-two.pdf', 'application/pdf', 10, 't_h2', 'WEB_UPLOAD', now()),
  ('t_doc_a2_1', 't_biz_a2', 'k3', 'a2-one.pdf', 'application/pdf', 10, 't_h3', 'WEB_UPLOAD', now()),
  ('t_doc_b1_1', 't_biz_b1', 'k4', 'b1-one.pdf', 'application/pdf', 10, 't_h4', 'WEB_UPLOAD', now());

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
  SET LOCAL app.actor_id = 't_user_a';
  SET LOCAL app.practice_id = 't_prac_a';
  SET LOCAL app.session_scope = 'user';

  SELECT assert_eq(count(*), 3, 'practice A sees its own 3 documents')
    FROM documents WHERE id LIKE 't\_%';
  SELECT assert_eq(count(*), 0, 'practice A sees no practice B documents')
    FROM documents WHERE id LIKE 't\_%' AND business_id = 't_biz_b1';
  SELECT assert_eq(count(*), 2, 'practice A sees its own 2 businesses')
    FROM businesses WHERE id LIKE 't\_%';
COMMIT;

-- === 3. cross-practice reads are blocked ===================================
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 't_user_b';
  SET LOCAL app.practice_id = 't_prac_b';
  SET LOCAL app.session_scope = 'user';

  SELECT assert_eq(count(*), 1, 'practice B sees only its own document')
    FROM documents WHERE id LIKE 't\_%';
  SELECT assert_eq(count(*), 0, 'practice B cannot see practice A documents')
    FROM documents WHERE id LIKE 't\_%' AND business_id LIKE 't_biz_a%';
COMMIT;

-- === 4. a client user sees only their own workspace ========================
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 't_user_client';
  SET LOCAL app.business_id = 't_biz_a1';
  SET LOCAL app.session_scope = 'user';

  SELECT assert_eq(count(*), 2, 'client user sees only its own workspace documents')
    FROM documents WHERE id LIKE 't\_%';
  SELECT assert_eq(count(*), 0, 'client user cannot see the sibling client')
    FROM documents WHERE id LIKE 't\_%' AND business_id = 't_biz_a2';
COMMIT;

-- === 5. delegated OTP session is scoped to granted items only ==============
-- The chase link is deliberately forwardable, so this restriction is
-- load-bearing rather than incidental (SoT Stage 8.3).
BEGIN;
  SET LOCAL ROLE nt_app;
  SET LOCAL app.actor_id = 't_user_client';
  SET LOCAL app.business_id = 't_biz_a1';
  SET LOCAL app.session_scope = 'delegated_upload';
  SET LOCAL app.granted_item_ids = 't_doc_a1_1';

  SELECT assert_eq(count(*), 1, 'delegated session sees exactly its granted item')
    FROM documents WHERE id LIKE 't\_%';
  SELECT assert_eq(count(*), 0, 'delegated session cannot see the other document in the same business')
    FROM documents WHERE id = 't_doc_a1_2';
  SELECT assert_eq(count(*), 0, 'delegated session cannot see any business row')
    FROM businesses WHERE id LIKE 't\_%';
COMMIT;

-- === 6. no context means no rows (global, not scoped) ======================
BEGIN;
  SET LOCAL ROLE nt_app;
  SELECT assert_eq(count(*), 0, 'no session context sees nothing at all') FROM documents;
COMMIT;

-- === 7. audit_events is append-only ========================================
INSERT INTO audit_events (id, business_id, seq, hash, event)
  VALUES ('t_aud_1', 't_biz_a1', 999001, 'h', 'test.event');

DO $$
BEGIN
  BEGIN
    UPDATE audit_events SET event = 'tampered' WHERE id = 't_aud_1';
    RAISE EXCEPTION 'FAIL: audit_events accepted an UPDATE';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: audit_events rejected UPDATE (%)', sqlerrm;
  END;

  BEGIN
    DELETE FROM audit_events WHERE id = 't_aud_1';
    RAISE EXCEPTION 'FAIL: audit_events accepted a DELETE';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: audit_events rejected DELETE (%)', sqlerrm;
  END;
END $$;

-- === 8. the Review → Approve guard =========================================
INSERT INTO action_proposals (id, business_id, kind, payload, payload_hash, expires_at)
  VALUES ('t_prop_1', 't_biz_a1', 'chase-send', '{}'::jsonb, 't_ph1', now() + interval '1 hour');

DO $$
BEGIN
  BEGIN
    UPDATE action_proposals SET approved_at = now(), state = 'APPROVED' WHERE id = 't_prop_1';
    RAISE EXCEPTION 'FAIL: proposal approved without review';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: approval without review rejected (%)', sqlerrm;
  END;

  BEGIN
    UPDATE action_proposals SET payload_hash = 'tampered' WHERE id = 't_prop_1';
    RAISE EXCEPTION 'FAIL: proposal payload_hash was allowed to change';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: payload_hash change rejected (%)', sqlerrm;
  END;

  UPDATE action_proposals SET reviewed_at = now(), state = 'REVIEWED' WHERE id = 't_prop_1';
  UPDATE action_proposals SET approved_at = now(), state = 'APPROVED' WHERE id = 't_prop_1';
  UPDATE action_proposals SET executed_at = now(), state = 'EXECUTED' WHERE id = 't_prop_1';
  RAISE NOTICE 'pass: review -> approve -> execute accepted';

  -- Terminal afterwards: no further update of any kind, including one writing
  -- an identical timestamp (now() is stable within a transaction).
  BEGIN
    UPDATE action_proposals SET executed_at = now() WHERE id = 't_prop_1';
    RAISE EXCEPTION 'FAIL: proposal executed twice';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass: second execution rejected (%)', sqlerrm;
  END;
END $$;

-- ------------------------------------------------------------- teardown ---
ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
DELETE FROM audit_events WHERE id LIKE 't\_%';
ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;

DELETE FROM action_proposals WHERE id LIKE 't\_%';
DELETE FROM documents        WHERE id LIKE 't\_%';
DELETE FROM memberships      WHERE id LIKE 't\_%';
DELETE FROM users            WHERE id LIKE 't\_%';
DELETE FROM businesses       WHERE id LIKE 't\_%';
DELETE FROM practices        WHERE id LIKE 't\_%';

\echo ''
\echo '================================================'
\echo ' TENANCY CHECK PASSED — seed data left intact'
\echo '================================================'
