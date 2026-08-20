-- ============================================================================
-- TripWith — schema invariant verification
--
-- Executable proof that the §36 design questions are answered by the DATABASE,
-- not by application convention. Every assertion here fails loudly if a future
-- migration weakens a constraint.
--
--   psql -d tripwith -v ON_ERROR_STOP=1 -f verify-invariants.sql
--
-- Runs inside a transaction and rolls back; it leaves no data behind.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE tw_test_results (
  label   TEXT,
  passed  BOOLEAN,
  detail  TEXT
) ON COMMIT DROP;

-- Asserts a statement is REJECTED, optionally with a specific SQLSTATE.
CREATE OR REPLACE FUNCTION tw_expect_error(
  p_sql TEXT, p_label TEXT, p_expect_sqlstate TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $fn$
DECLARE
  got TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO tw_test_results VALUES (p_label, FALSE, 'expected rejection, but statement SUCCEEDED');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;

  IF p_expect_sqlstate IS NOT NULL AND got <> p_expect_sqlstate THEN
    INSERT INTO tw_test_results
      VALUES (p_label, FALSE, format('expected SQLSTATE %s, got %s', p_expect_sqlstate, got));
  ELSE
    INSERT INTO tw_test_results VALUES (p_label, TRUE, 'rejected with SQLSTATE ' || got);
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION tw_assert(
  p_condition BOOLEAN, p_label TEXT, p_detail TEXT DEFAULT ''
) RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO tw_test_results
    VALUES (p_label, COALESCE(p_condition, FALSE), p_detail);
END $fn$;


-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE tw_ids (k TEXT PRIMARY KEY, v UUID) ON COMMIT DROP;

DO $seed$
DECLARE
  u_alice UUID; u_bob UUID; u_carol UUID; u_host UUID;
  t_alice UUID; ev UUID; room UUID; prov UUID;
BEGIN
  INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
  VALUES ('fb_alice', 'alice@example.com', CURRENT_DATE - INTERVAL '28 years', 'ACTIVE')
  RETURNING id INTO u_alice;

  INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
  VALUES ('fb_bob', 'bob@example.com', CURRENT_DATE - INTERVAL '31 years', 'ACTIVE')
  RETURNING id INTO u_bob;

  INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
  VALUES ('fb_carol', 'carol@example.com', CURRENT_DATE - INTERVAL '25 years', 'ACTIVE')
  RETURNING id INTO u_carol;

  INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
  VALUES ('fb_host', 'host@example.com', CURRENT_DATE - INTERVAL '40 years', 'ACTIVE')
  RETURNING id INTO u_host;

  INSERT INTO user_profiles (user_id, display_name, travel_style)
    VALUES (u_alice, 'Alice', 2), (u_bob, 'Bob', 3),
           (u_carol, 'Carol', 4), (u_host, 'Hostie', 3);
  INSERT INTO user_settings (user_id) VALUES (u_alice), (u_bob), (u_carol), (u_host);

  INSERT INTO trips (user_id, title, start_date, end_date)
  VALUES (u_alice, 'SE Asia', DATE '2026-09-01', DATE '2026-10-15')
  RETURNING id INTO t_alice;

  INSERT INTO trip_segments (trip_id, user_id, destination_name, location, start_date, end_date)
  VALUES (t_alice, u_alice, 'Bangkok',
          ST_MakePoint(100.5018, 13.7563)::GEOGRAPHY, DATE '2026-09-01', DATE '2026-09-20');

  INSERT INTO providers (slug, name, owner_user_id) VALUES ('surf-co', 'Surf Co', u_host)
  RETURNING id INTO prov;

  INSERT INTO events (
    host_type, host_user_id, category_id, title, capacity_max,
    starts_at, ends_at, meeting_point, status
  ) VALUES (
    'USER', u_host, (SELECT id FROM event_categories WHERE code = 'trek'),
    'Sunrise Trek', 2,
    now() + INTERVAL '10 days', now() + INTERVAL '10 days 6 hours',
    ST_MakePoint(100.5018, 13.7563)::GEOGRAPHY, 'ACTIVE'
  ) RETURNING id INTO ev;

  INSERT INTO chat_rooms (type) VALUES ('MATCH') RETURNING id INTO room;

  INSERT INTO tw_ids VALUES
    ('alice', u_alice), ('bob', u_bob), ('carol', u_carol), ('host', u_host),
    ('trip_alice', t_alice), ('event', ev), ('room', room), ('provider', prov);
END $seed$;

CREATE OR REPLACE FUNCTION tw_id(k TEXT) RETURNS UUID
LANGUAGE sql STABLE AS $fn$ SELECT v FROM tw_ids WHERE tw_ids.k = $1 $fn$;


-- ---------------------------------------------------------------------------
-- 1. Age policy (18+) — enforced by trigger, since CHECK cannot use CURRENT_DATE
-- ---------------------------------------------------------------------------
SELECT tw_expect_error($$
  INSERT INTO users (firebase_uid, email, date_of_birth)
  VALUES ('fb_minor', 'minor@example.com', CURRENT_DATE - INTERVAL '17 years')
$$, '18+ enforced: 17-year-old signup rejected', '23514');

SELECT tw_expect_error($$
  UPDATE users SET date_of_birth = CURRENT_DATE - INTERVAL '12 years'
  WHERE email = 'alice@example.com'
$$, '18+ enforced: cannot backdate DOB below 18', '23514');


-- ---------------------------------------------------------------------------
-- 2. Trust projection == clamp(5.0 + SUM(deltas))   [correction #2]
-- ---------------------------------------------------------------------------
DO $trust$
DECLARE
  a UUID := tw_id('alice');
  raw NUMERIC; pub NUMERIC;
BEGIN
  -- Drive the user deep below zero.
  INSERT INTO trust_score_events (user_id, type, delta, idempotency_key)
  VALUES (a, 'VERIFIED_NO_SHOW', -7.0, 'k1');

  SELECT trust_score_raw, trust_score INTO raw, pub FROM users WHERE id = a;
  PERFORM tw_assert(raw = -2.0 AND pub = 0.00,
    'trust: raw sum unclamped, public score floors at 0',
    format('raw=%s public=%s', raw, pub));

  -- The divergence case: a small positive delta while underwater.
  -- Incremental clamping would show 0.20 here. Correct behaviour is 0.00.
  INSERT INTO trust_score_events (user_id, type, delta, idempotency_key)
  VALUES (a, 'EVENT_ATTENDED', 0.2, 'k2');

  SELECT trust_score_raw, trust_score INTO raw, pub FROM users WHERE id = a;
  PERFORM tw_assert(raw = -1.8 AND pub = 0.00,
    'trust: no divergence — clamp(sum) not sum(clamp)',
    format('raw=%s public=%s (incremental clamping would give 0.20)', raw, pub));

  -- Recovery must be genuine, not instant.
  INSERT INTO trust_score_events (user_id, type, delta, idempotency_key)
  VALUES (a, 'MODERATION_ADJUSTMENT', 5.0, 'k3');

  SELECT trust_score_raw, trust_score INTO raw, pub FROM users WHERE id = a;
  PERFORM tw_assert(raw = 3.2 AND pub = 3.20,
    'trust: recovery from below zero requires real credit',
    format('raw=%s public=%s', raw, pub));

  -- Ceiling behaves symmetrically.
  INSERT INTO trust_score_events (user_id, type, delta, idempotency_key)
  VALUES (a, 'MODERATION_ADJUSTMENT', 9.0, 'k4');
  SELECT trust_score_raw, trust_score INTO raw, pub FROM users WHERE id = a;
  PERFORM tw_assert(raw = 12.2 AND pub = 10.00,
    'trust: public score ceilings at 10',
    format('raw=%s public=%s', raw, pub));

  -- The projection equals a full ledger replay, exactly.
  PERFORM tw_assert(
    (SELECT trust_score_raw FROM users WHERE id = a)
      = 5.0 + (SELECT SUM(delta) FROM trust_score_events WHERE user_id = a),
    'trust: projection identical to full ledger replay');
END $trust$;

SELECT tw_expect_error($$
  INSERT INTO trust_score_events (user_id, type, delta, idempotency_key)
  VALUES (tw_id('alice'), 'EVENT_ATTENDED', 0.2, 'k1')
$$, 'trust: duplicate idempotency_key rejected', '23505');

SELECT tw_expect_error($$
  UPDATE trust_score_events SET delta = 99 WHERE idempotency_key = 'k1'
$$, 'trust: ledger is append-only (UPDATE blocked)', '23001');

SELECT tw_expect_error($$
  DELETE FROM trust_score_events WHERE idempotency_key = 'k1'
$$, 'trust: ledger is append-only (DELETE blocked)', '23001');

SELECT tw_expect_error($$
  INSERT INTO trust_score_events (user_id, source_user_id, type, delta, idempotency_key)
  VALUES (tw_id('alice'), tw_id('alice'), 'POSITIVE_REVIEW', 0.3, 'k_self')
$$, 'trust: cannot credit yourself', '23514');


-- ---------------------------------------------------------------------------
-- 3. Duplicate matches impossible
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  lo UUID := LEAST(tw_id('alice'), tw_id('bob'));
  hi UUID := GREATEST(tw_id('alice'), tw_id('bob'));
BEGIN
  INSERT INTO matches (user_a_id, user_b_id, chat_room_id)
  VALUES (lo, hi, tw_id('room'));
  PERFORM tw_assert(TRUE, 'match: canonical pair inserted');
END $m$;

SELECT tw_expect_error(format($$
  INSERT INTO matches (user_a_id, user_b_id, chat_room_id)
  VALUES (%L, %L, (SELECT id FROM chat_rooms LIMIT 1))
$$, LEAST(tw_id('alice'), tw_id('bob')), GREATEST(tw_id('alice'), tw_id('bob'))),
  'match: exact duplicate rejected', '23505');

-- The reversed pair is what a naive UNIQUE(a,b) would let through.
SELECT tw_expect_error(format($$
  INSERT INTO matches (user_a_id, user_b_id, chat_room_id)
  VALUES (%L, %L, (SELECT id FROM chat_rooms LIMIT 1))
$$, GREATEST(tw_id('alice'), tw_id('bob')), LEAST(tw_id('alice'), tw_id('bob'))),
  'match: REVERSED pair rejected by canonical ordering', '23514');


-- ---------------------------------------------------------------------------
-- 4. Swipes / blocks
-- ---------------------------------------------------------------------------
SELECT tw_expect_error(format($$
  INSERT INTO swipes (source_user_id, target_user_id, direction) VALUES (%L, %L, 'LIKE')
$$, tw_id('alice'), tw_id('alice')), 'swipe: self-swipe rejected', '23514');

INSERT INTO swipes (source_user_id, target_user_id, direction)
VALUES (tw_id('alice'), tw_id('carol'), 'LIKE');

SELECT tw_expect_error(format($$
  INSERT INTO swipes (source_user_id, target_user_id, direction) VALUES (%L, %L, 'PASS')
$$, tw_id('alice'), tw_id('carol')), 'swipe: one decision per pair', '23505');

SELECT tw_expect_error(format($$
  INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (%L, %L)
$$, tw_id('alice'), tw_id('alice')), 'block: self-block rejected', '23514');


-- ---------------------------------------------------------------------------
-- 5. Event capacity + duplicate participation
-- ---------------------------------------------------------------------------
DO $cap$
DECLARE
  ev UUID := tw_id('event');
  cnt INT;
BEGIN
  INSERT INTO event_participants (event_id, user_id) VALUES (ev, tw_id('alice'));
  INSERT INTO event_participants (event_id, user_id) VALUES (ev, tw_id('bob'));
  SELECT participant_count INTO cnt FROM events WHERE id = ev;
  PERFORM tw_assert(cnt = 2, 'event: participant_count maintained by trigger',
    format('count=%s', cnt));
END $cap$;

SELECT tw_expect_error(format($$
  INSERT INTO event_participants (event_id, user_id) VALUES (%L, %L)
$$, tw_id('event'), tw_id('alice')), 'event: duplicate participation rejected', '23505');

-- capacity_max = 2 and two seats are taken.
SELECT tw_expect_error(format($$
  INSERT INTO event_participants (event_id, user_id) VALUES (%L, %L)
$$, tw_id('event'), tw_id('carol')),
  'event: over-capacity insert rejected by CHECK', '23514');

-- Freeing a seat must let the next participant in.
DO $free$
DECLARE cnt INT;
BEGIN
  UPDATE event_participants
     SET cancelled_at = now(), attendance_status = 'CANCELLED'
   WHERE event_id = tw_id('event') AND user_id = tw_id('bob');
  SELECT participant_count INTO cnt FROM events WHERE id = tw_id('event');
  PERFORM tw_assert(cnt = 1, 'event: cancellation decrements count', format('count=%s', cnt));

  INSERT INTO event_participants (event_id, user_id) VALUES (tw_id('event'), tw_id('carol'));
  SELECT participant_count INTO cnt FROM events WHERE id = tw_id('event');
  PERFORM tw_assert(cnt = 2, 'event: freed seat is reusable', format('count=%s', cnt));
END $free$;


-- ---------------------------------------------------------------------------
-- 6. Join requests
-- ---------------------------------------------------------------------------
INSERT INTO event_join_requests (event_id, user_id, expires_at)
VALUES (tw_id('event'), tw_id('bob'), now() + INTERVAL '24 hours');

SELECT tw_expect_error(format($$
  INSERT INTO event_join_requests (event_id, user_id, expires_at)
  VALUES (%L, %L, now() + INTERVAL '24 hours')
$$, tw_id('event'), tw_id('bob')),
  'join request: duplicate ACTIVE request rejected', '23505');

-- After rejection the same user may ask again.
DO $rr$
BEGIN
  UPDATE event_join_requests
     SET status = 'REJECTED', rejected_at = now()
   WHERE event_id = tw_id('event') AND user_id = tw_id('bob');

  INSERT INTO event_join_requests (event_id, user_id, expires_at)
  VALUES (tw_id('event'), tw_id('bob'), now() + INTERVAL '24 hours');

  PERFORM tw_assert(TRUE, 'join request: re-request allowed after rejection');
EXCEPTION WHEN OTHERS THEN
  PERFORM tw_assert(FALSE, 'join request: re-request allowed after rejection', SQLERRM);
END $rr$;

SELECT tw_expect_error(format($$
  INSERT INTO event_join_requests (event_id, user_id, expires_at)
  VALUES (%L, %L, now() - INTERVAL '1 hour')
$$, tw_id('event'), tw_id('carol')),
  'join request: expiry must be in the future relative to request', '23514');


-- ---------------------------------------------------------------------------
-- 7. Event state machine + audit
-- ---------------------------------------------------------------------------
SELECT tw_expect_error(format($$
  UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = %L
$$, tw_id('event')), 'event FSM: ACTIVE -> COMPLETED rejected', '23514');

SELECT tw_expect_error(format($$
  UPDATE events SET status = 'DRAFT' WHERE id = %L
$$, tw_id('event')), 'event FSM: ACTIVE -> DRAFT rejected', '23514');

DO $fsm$
DECLARE n INT;
BEGIN
  UPDATE events SET status = 'IN_PROGRESS' WHERE id = tw_id('event');
  UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = tw_id('event');

  SELECT count(*) INTO n FROM event_status_history WHERE event_id = tw_id('event');
  -- creation seed + ACTIVE->IN_PROGRESS + IN_PROGRESS->COMPLETED
  PERFORM tw_assert(n = 3, 'event FSM: every transition audited automatically',
    format('history rows=%s', n));

  PERFORM tw_assert(
    EXISTS (SELECT 1 FROM event_status_history
             WHERE event_id = tw_id('event')
               AND from_status = 'IN_PROGRESS' AND to_status = 'COMPLETED'),
    'event FSM: history records from/to accurately');
END $fsm$;

SELECT tw_expect_error($$
  UPDATE event_status_history SET to_status = 'DRAFT'
$$, 'event FSM: history is append-only', '23001');


-- ---------------------------------------------------------------------------
-- 8. Payments: webhook idempotency + internal/external status separation
-- ---------------------------------------------------------------------------
DO $pay$
DECLARE p UUID; inserted INT;
BEGIN
  INSERT INTO payments (user_id, kind, event_id, provider, amount_minor, idempotency_key,
                        provider_payment_intent_id, status, provider_status)
  VALUES (tw_id('alice'), 'EVENT_DEPOSIT', tw_id('event'), 'stripe', 1500, 'pay_1',
          'pi_abc', 'AUTHORIZED', 'requires_capture')
  RETURNING id INTO p;

  INSERT INTO payment_events (payment_id, provider, provider_event_id, event_type,
                              signature_verified, payload)
  VALUES (p, 'stripe', 'evt_1', 'payment_intent.amount_capturable_updated', TRUE, '{}'::JSONB);

  -- Replay of the same webhook: the insert-first pattern absorbs it.
  INSERT INTO payment_events (payment_id, provider, provider_event_id, event_type,
                              signature_verified, payload)
  VALUES (p, 'stripe', 'evt_1', 'payment_intent.amount_capturable_updated', TRUE, '{}'::JSONB)
  ON CONFLICT (provider, provider_event_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  PERFORM tw_assert(inserted = 0,
    'payment: replayed webhook inserts 0 rows (idempotent)',
    format('rows inserted on replay=%s', inserted));

  PERFORM tw_assert(
    (SELECT count(*) FROM payment_events WHERE provider_event_id = 'evt_1') = 1,
    'payment: exactly one event row survives replay');
END $pay$;

SELECT tw_expect_error(format($$
  INSERT INTO payments (user_id, kind, event_id, provider, amount_minor, idempotency_key)
  VALUES (%L, 'EVENT_DEPOSIT', %L, 'stripe', -100, 'pay_neg')
$$, tw_id('alice'), tw_id('event')), 'payment: negative amount rejected', '23514');

SELECT tw_expect_error(format($$
  UPDATE payments SET captured_amount_minor = 9999 WHERE idempotency_key = 'pay_1'
$$), 'payment: cannot capture more than authorized', '23514');

-- A deposit with no event to attach to is meaningless.
SELECT tw_expect_error(format($$
  INSERT INTO payments (user_id, kind, event_id, provider, amount_minor, idempotency_key)
  VALUES (%L, 'EVENT_DEPOSIT', NULL, 'stripe', 100, 'pay_no_event')
$$, tw_id('alice')),
  'payment: EVENT_DEPOSIT without an event rejected', '23514');

-- ...and a subscription charge must not be attached to an event.
SELECT tw_expect_error(format($$
  INSERT INTO payments (user_id, kind, event_id, provider, amount_minor, idempotency_key)
  VALUES (%L, 'PROVIDER_SUBSCRIPTION', %L, 'stripe', 100, 'pay_sub_event')
$$, tw_id('alice'), tw_id('event')),
  'payment: PROVIDER_SUBSCRIPTION tied to an event rejected', '23514');


-- ---------------------------------------------------------------------------
-- 9. Provider provenance & publication gate
-- ---------------------------------------------------------------------------
SELECT tw_expect_error($$
  INSERT INTO providers (slug, name, published_at) VALUES ('ghost-co', 'Ghost Co', now())
$$, 'provider: cannot publish without owner confirmation', '23514');

DO $prov$
BEGIN
  INSERT INTO providers (slug, name, confirmed_by_owner_at, published_at)
  VALUES ('real-co', 'Real Co', now(), now());
  PERFORM tw_assert(TRUE, 'provider: publish allowed once confirmed');
END $prov$;

SELECT tw_expect_error(format($$
  INSERT INTO provider_external_sources (provider_id, source, external_id, cached_at)
  VALUES (%L, 'GOOGLE_PLACES', 'ChIJxyz', now())
$$, tw_id('provider')),
  'provider: cached external data must carry a TTL', '23514');

DO $ext$
BEGIN
  INSERT INTO provider_external_sources
    (provider_id, source, external_id, cached_display_name, cached_at, cache_expires_at,
     attribution_text)
  VALUES (tw_id('provider'), 'GOOGLE_PLACES', 'ChIJxyz', 'Surf Co',
          now(), now() + INTERVAL '30 days', 'Data © Google');
  PERFORM tw_assert(TRUE, 'provider: external cache row accepted with TTL + attribution');
END $ext$;

SELECT tw_assert(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'provider_external_sources'
       AND column_name IN ('cached_rating', 'cached_reviews', 'cached_photos', 'raw_payload')
  ),
  'provider: no column exists for restricted Google content (ratings/reviews/photos)');


-- ---------------------------------------------------------------------------
-- 10. Reviews anti-abuse
-- ---------------------------------------------------------------------------
SELECT tw_expect_error(format($$
  INSERT INTO reviews (reviewer_user_id, target_type, target_user_id, event_id, rating)
  VALUES (%L, 'USER', %L, %L, 5)
$$, tw_id('alice'), tw_id('alice'), tw_id('event')),
  'review: self-review rejected', '23514');

INSERT INTO reviews (reviewer_user_id, target_type, target_user_id, event_id, rating)
VALUES (tw_id('alice'), 'USER', tw_id('host'), tw_id('event'), 5);

SELECT tw_expect_error(format($$
  INSERT INTO reviews (reviewer_user_id, target_type, target_user_id, event_id, rating)
  VALUES (%L, 'USER', %L, %L, 1)
$$, tw_id('alice'), tw_id('host'), tw_id('event')),
  'review: one review per (reviewer, event, reviewee)', '23505');

SELECT tw_expect_error(format($$
  INSERT INTO reviews (reviewer_user_id, target_type, target_user_id, event_id, rating)
  VALUES (%L, 'USER', %L, %L, 9)
$$, tw_id('bob'), tw_id('host'), tw_id('event')),
  'review: rating outside 1..5 rejected', '23514');

SELECT tw_expect_error(format($$
  INSERT INTO reviews (reviewer_user_id, target_type, target_user_id, rating, is_verified)
  VALUES (%L, 'USER', %L, 5, TRUE)
$$, tw_id('bob'), tw_id('host')),
  'review: verified review requires an event context', '23514');


-- ---------------------------------------------------------------------------
-- 11. Chat: gapless seq, O(1) unread, no JSON membership
-- ---------------------------------------------------------------------------
DO $chat$
DECLARE
  room UUID := tw_id('room');
  seqs BIGINT[];
  unread BIGINT;
BEGIN
  INSERT INTO chat_members (room_id, user_id) VALUES (room, tw_id('alice')), (room, tw_id('bob'));

  INSERT INTO messages (room_id, sender_user_id, body) VALUES (room, tw_id('alice'), 'hey');
  INSERT INTO messages (room_id, sender_user_id, body) VALUES (room, tw_id('bob'), 'hi');
  INSERT INTO messages (room_id, sender_user_id, body) VALUES (room, tw_id('alice'), 'how are you');

  SELECT array_agg(seq ORDER BY seq) INTO seqs FROM messages WHERE room_id = room;
  PERFORM tw_assert(seqs = ARRAY[1,2,3]::BIGINT[],
    'chat: seq assigned gaplessly by trigger', format('seqs=%s', seqs));

  PERFORM tw_assert((SELECT last_seq FROM chat_rooms WHERE id = room) = 3,
    'chat: room cursor advanced');

  SELECT r.last_seq - m.last_read_seq INTO unread
    FROM chat_rooms r JOIN chat_members m ON m.room_id = r.id
   WHERE r.id = room AND m.user_id = tw_id('bob');
  PERFORM tw_assert(unread = 3, 'chat: unread count is O(1) subtraction',
    format('unread=%s', unread));

  UPDATE chat_members SET last_read_seq = 3 WHERE room_id = room AND user_id = tw_id('bob');
  SELECT r.last_seq - m.last_read_seq INTO unread
    FROM chat_rooms r JOIN chat_members m ON m.room_id = r.id
   WHERE r.id = room AND m.user_id = tw_id('bob');
  PERFORM tw_assert(unread = 0, 'chat: marking read zeroes unread');
END $chat$;

SELECT tw_expect_error(format($$
  INSERT INTO messages (room_id, sender_user_id, type, body) VALUES (%L, %L, 'TEXT', NULL)
$$, tw_id('room'), tw_id('alice')), 'chat: TEXT message requires a body', '23514');

SELECT tw_expect_error(format($$
  INSERT INTO messages (room_id, sender_user_id, type, body) VALUES (%L, %L, 'LOCATION', 'x')
$$, tw_id('room'), tw_id('alice')),
  'chat: LOCATION message requires a point', '23514');

SELECT tw_assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'chat_rooms' AND data_type = 'jsonb') = 0,
  'chat: membership is not stored as JSON on chat_rooms');


-- ---------------------------------------------------------------------------
-- 12. Live-location privacy invariant
-- ---------------------------------------------------------------------------
SELECT tw_assert(
  NOT EXISTS (
    SELECT 1
      FROM information_schema.columns c
      JOIN pg_type t ON t.typname = 'geography'
     WHERE c.table_schema = 'public'
       AND c.udt_name = 'geography'
       AND c.table_name IN ('users', 'user_profiles', 'user_settings')
  ),
  'privacy: no geography column exists on any user identity table');

SELECT tw_assert(
  (SELECT count(*) FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_am a ON a.oid = ic.relam
    WHERE c.relname = 'sos_location_updates' AND a.amname = 'gist') = 0,
  'privacy: sos_location_updates has NO spatial index (proximity search impossible)');

SELECT tw_assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND udt_name = 'geography') = 6,
  'privacy: geography columns confined to the 6 intended tables',
  (SELECT string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND udt_name = 'geography'));

SELECT tw_expect_error($$
  INSERT INTO sos_sessions (user_id, token_hash, expires_at)
  VALUES (tw_id('alice'), '\x00'::BYTEA, now() + INTERVAL '2 hours')
$$, 'sos: token hash must be a full 32-byte digest', '23514');

DO $sos$
BEGIN
  INSERT INTO sos_sessions (user_id, token_hash, expires_at)
  VALUES (tw_id('alice'), sha256('secret-token'::BYTEA), now() + INTERVAL '2 hours');
  PERFORM tw_assert(TRUE, 'sos: session accepts a SHA-256 token hash');
END $sos$;

SELECT tw_expect_error($$
  INSERT INTO sos_sessions (user_id, token_hash, expires_at)
  VALUES (tw_id('alice'), sha256('other'::BYTEA), now() + INTERVAL '1 hour')
$$, 'sos: only one ACTIVE session per user', '23505');


-- ---------------------------------------------------------------------------
-- 13. Interests projection stays in sync
-- ---------------------------------------------------------------------------
DO $int$
DECLARE ids INT[]; i1 INT; i2 INT;
BEGIN
  INSERT INTO interests (code, label) VALUES ('hiking', 'Hiking') RETURNING id INTO i1;
  INSERT INTO interests (code, label) VALUES ('diving', 'Diving') RETURNING id INTO i2;

  INSERT INTO user_interests (user_id, interest_id) VALUES (tw_id('alice'), i1), (tw_id('alice'), i2);
  SELECT interest_ids INTO ids FROM user_profiles WHERE user_id = tw_id('alice');
  PERFORM tw_assert(ids @> ARRAY[i1, i2] AND cardinality(ids) = 2,
    'interests: array projection synced on INSERT', format('ids=%s', ids));

  DELETE FROM user_interests WHERE user_id = tw_id('alice') AND interest_id = i1;
  SELECT interest_ids INTO ids FROM user_profiles WHERE user_id = tw_id('alice');
  PERFORM tw_assert(ids = ARRAY[i2], 'interests: array projection synced on DELETE',
    format('ids=%s', ids));
END $int$;


-- ---------------------------------------------------------------------------
-- 14. Trip overlap semantics
-- ---------------------------------------------------------------------------
DO $overlap$
DECLARE hit BOOLEAN;
BEGIN
  PERFORM tw_assert(
    (SELECT date_range FROM trip_segments LIMIT 1) = daterange('2026-09-01','2026-09-20','[]'),
    'trips: date_range generated inclusive of both endpoints');

  SELECT EXISTS (
    SELECT 1 FROM trip_segments
     WHERE date_range && daterange('2026-09-19','2026-09-25','[]')
  ) INTO hit;
  PERFORM tw_assert(hit, 'trips: single-day tail overlap detected');

  SELECT EXISTS (
    SELECT 1 FROM trip_segments
     WHERE date_range && daterange('2026-09-21','2026-09-30','[]')
  ) INTO hit;
  PERFORM tw_assert(NOT hit, 'trips: adjacent-but-disjoint range not treated as overlap');
END $overlap$;


-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
\echo ''
\echo '================ INVARIANT VERIFICATION ================'
SELECT
  CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
  label,
  detail
FROM tw_test_results
ORDER BY passed, label;

\echo ''
SELECT format('%s passed, %s failed, %s total',
              count(*) FILTER (WHERE passed),
              count(*) FILTER (WHERE NOT passed),
              count(*)) AS summary
FROM tw_test_results;

DO $final$
DECLARE failures INT;
BEGIN
  SELECT count(*) INTO failures FROM tw_test_results WHERE NOT passed;
  IF failures > 0 THEN
    RAISE EXCEPTION 'INVARIANT VERIFICATION FAILED: % assertion(s) did not hold', failures;
  END IF;
END $final$;

ROLLBACK;
