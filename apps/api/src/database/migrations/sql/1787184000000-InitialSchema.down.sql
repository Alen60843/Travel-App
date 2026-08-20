-- ============================================================================
-- TripWith — Initial schema, DOWN
--
-- Reverses 1787184000000-InitialSchema.up.sql.
--
-- Extensions (postgis, btree_gist, intarray) are deliberately NOT dropped:
-- they are database-scoped, may be shared with other schemas, and dropping
-- postgis would cascade into every geography column in the database.
-- ============================================================================

-- Tables, reverse dependency order. CASCADE also removes their triggers,
-- indexes and constraints.
DROP TABLE IF EXISTS job_outbox              CASCADE;
DROP TABLE IF EXISTS sos_access_log          CASCADE;
DROP TABLE IF EXISTS sos_location_updates    CASCADE;
DROP TABLE IF EXISTS sos_sessions            CASCADE;
DROP TABLE IF EXISTS reports                 CASCADE;
DROP TABLE IF EXISTS user_blocks             CASCADE;
DROP TABLE IF EXISTS account_restrictions    CASCADE;
DROP TABLE IF EXISTS trust_score_events      CASCADE;
DROP TABLE IF EXISTS reviews                 CASCADE;
DROP TABLE IF EXISTS messages                CASCADE;
DROP TABLE IF EXISTS chat_members            CASCADE;
DROP TABLE IF EXISTS matches                 CASCADE;
DROP TABLE IF EXISTS chat_rooms              CASCADE;
DROP TABLE IF EXISTS swipes                  CASCADE;
DROP TABLE IF EXISTS event_participants      CASCADE;
DROP TABLE IF EXISTS event_join_requests     CASCADE;
DROP TABLE IF EXISTS payment_events          CASCADE;
DROP TABLE IF EXISTS payments                CASCADE;
DROP TABLE IF EXISTS event_status_history    CASCADE;
DROP TABLE IF EXISTS events                  CASCADE;
DROP TABLE IF EXISTS event_categories        CASCADE;
DROP TABLE IF EXISTS provider_subscriptions  CASCADE;
DROP TABLE IF EXISTS provider_categories     CASCADE;
DROP TABLE IF EXISTS provider_media          CASCADE;
DROP TABLE IF EXISTS provider_external_sources CASCADE;
DROP TABLE IF EXISTS providers               CASCADE;
DROP TABLE IF EXISTS provider_category_types CASCADE;
DROP TABLE IF EXISTS trip_segments           CASCADE;
DROP TABLE IF EXISTS trips                   CASCADE;
DROP TABLE IF EXISTS user_interests          CASCADE;
DROP TABLE IF EXISTS interests               CASCADE;
DROP TABLE IF EXISTS user_consents           CASCADE;
DROP TABLE IF EXISTS user_settings           CASCADE;
DROP TABLE IF EXISTS user_profiles           CASCADE;
DROP TABLE IF EXISTS users                   CASCADE;

-- Trigger functions
DROP FUNCTION IF EXISTS tw_guard_join_approval()      CASCADE;
DROP FUNCTION IF EXISTS tw_sync_provider_rating()     CASCADE;
DROP FUNCTION IF EXISTS tw_apply_trust_delta()        CASCADE;
DROP FUNCTION IF EXISTS tw_assign_message_seq()       CASCADE;
DROP FUNCTION IF EXISTS tw_sync_participant_count()   CASCADE;
DROP FUNCTION IF EXISTS tw_event_status_seed()        CASCADE;
DROP FUNCTION IF EXISTS tw_event_status_guard()       CASCADE;
DROP FUNCTION IF EXISTS tw_sync_interest_ids()        CASCADE;
DROP FUNCTION IF EXISTS tw_enforce_minimum_age()      CASCADE;
DROP FUNCTION IF EXISTS tw_forbid_mutation()          CASCADE;
DROP FUNCTION IF EXISTS tw_set_updated_at()           CASCADE;

-- Enumerated types
DROP TYPE IF EXISTS subscription_status  CASCADE;
DROP TYPE IF EXISTS media_kind           CASCADE;
DROP TYPE IF EXISTS consent_type         CASCADE;
DROP TYPE IF EXISTS external_source      CASCADE;
DROP TYPE IF EXISTS sos_session_status   CASCADE;
DROP TYPE IF EXISTS restriction_type     CASCADE;
DROP TYPE IF EXISTS report_status        CASCADE;
DROP TYPE IF EXISTS report_target_type   CASCADE;
DROP TYPE IF EXISTS moderation_state     CASCADE;
DROP TYPE IF EXISTS review_target_type   CASCADE;
DROP TYPE IF EXISTS trust_event_type     CASCADE;
DROP TYPE IF EXISTS payment_kind         CASCADE;
DROP TYPE IF EXISTS payment_status       CASCADE;
DROP TYPE IF EXISTS message_type         CASCADE;
DROP TYPE IF EXISTS chat_room_type       CASCADE;
DROP TYPE IF EXISTS swipe_direction      CASCADE;
DROP TYPE IF EXISTS attendance_status    CASCADE;
DROP TYPE IF EXISTS join_request_status  CASCADE;
DROP TYPE IF EXISTS event_host_type      CASCADE;
DROP TYPE IF EXISTS event_visibility     CASCADE;
DROP TYPE IF EXISTS event_status         CASCADE;
DROP TYPE IF EXISTS trip_visibility      CASCADE;
DROP TYPE IF EXISTS user_account_status  CASCADE;
