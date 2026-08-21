\set ON_ERROR_STOP on

-- Remove only the deterministic Phase 4 matching benchmark fixture. The
-- append-only consent trigger is disabled for this transaction because the
-- fixture users cascade to their synthetic consent rows.
BEGIN;
ALTER TABLE user_consents DISABLE TRIGGER user_consents_append_only;
DELETE FROM users WHERE firebase_uid LIKE 'phase4-bench-%';
ALTER TABLE user_consents ENABLE TRIGGER user_consents_append_only;
DELETE FROM interests WHERE code LIKE 'phase4_bench_%';
COMMIT;
