#!/usr/bin/env bash
# ============================================================================
# TripWith — concurrent capacity race verification
#
# Proves the §36 question "can it handle concurrent users taking the final
# event slot?" against a real server with real parallel connections.
#
# N workers race to join an event with capacity C. All N block on a shared
# advisory barrier, then fire simultaneously. Exactly C must win.
#
# Usage: PGPORT=55432 ./verify-concurrency.sh
# ============================================================================
set -uo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-tripwith}"
export PGHOST PGPORT PGUSER PGDATABASE

WORKERS="${WORKERS:-24}"
CAPACITY="${CAPACITY:-5}"
BARRIER_ID=424242

psql_q() { psql -qAt -v ON_ERROR_STOP=1 "$@"; }

echo "=== setting up: capacity=${CAPACITY}, racing workers=${WORKERS} ==="

psql_q <<SQL >/dev/null
DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE title = 'RACE TEST');
DELETE FROM event_status_history WHERE event_id IN (SELECT id FROM events WHERE title = 'RACE TEST');
DELETE FROM events WHERE title = 'RACE TEST';
DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'race_%');
DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'race_%');
DELETE FROM users WHERE firebase_uid LIKE 'race_%';

INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
SELECT 'race_host', 'race_host@example.com', CURRENT_DATE - INTERVAL '35 years', 'ACTIVE';

INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
SELECT 'race_' || g, 'race' || g || '@example.com',
       CURRENT_DATE - INTERVAL '30 years', 'ACTIVE'
  FROM generate_series(1, ${WORKERS}) g;

INSERT INTO events (host_type, host_user_id, category_id, title, capacity_max,
                    starts_at, ends_at, meeting_point, status)
SELECT 'USER',
       (SELECT id FROM users WHERE firebase_uid = 'race_host'),
       (SELECT id FROM event_categories WHERE code = 'trek'),
       'RACE TEST', ${CAPACITY},
       now() + INTERVAL '5 days', now() + INTERVAL '5 days 4 hours',
       ST_MakePoint(100.5, 13.75)::GEOGRAPHY, 'ACTIVE';
SQL

EVENT_ID=$(psql_q -c "SELECT id FROM events WHERE title = 'RACE TEST'")

# Hold the barrier exclusively so every worker blocks before its INSERT.
psql -qAt -c "SELECT pg_advisory_lock(${BARRIER_ID}); SELECT pg_sleep(4);" >/dev/null 2>&1 &
BARRIER_PID=$!
sleep 1

TMPDIR_RUN=$(mktemp -d)
for i in $(seq 1 "$WORKERS"); do
  (
    psql -qAt -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>"${TMPDIR_RUN}/err_${i}"
BEGIN;
SELECT pg_advisory_xact_lock_shared(${BARRIER_ID});
INSERT INTO event_participants (event_id, user_id)
VALUES ('${EVENT_ID}', (SELECT id FROM users WHERE firebase_uid = 'race_${i}'));
COMMIT;
SQL
    echo $? > "${TMPDIR_RUN}/rc_${i}"
  ) &
done

wait "$BARRIER_PID" 2>/dev/null
wait

SUCCEEDED=$(cat "${TMPDIR_RUN}"/rc_* 2>/dev/null | grep -c '^0$')
FAILED=$(cat "${TMPDIR_RUN}"/rc_* 2>/dev/null | grep -vc '^0$')
ROWS=$(psql_q -c "SELECT count(*) FROM event_participants WHERE event_id = '${EVENT_ID}' AND cancelled_at IS NULL")
COUNTER=$(psql_q -c "SELECT participant_count FROM events WHERE id = '${EVENT_ID}'")
CAPCHECK=$(grep -ho 'events_capacity_not_exceeded_chk' "${TMPDIR_RUN}"/err_* 2>/dev/null | wc -l | tr -d ' ')

echo
echo "workers that committed : ${SUCCEEDED}"
echo "workers rejected       : ${FAILED}"
echo "  ...by capacity CHECK : ${CAPCHECK}"
echo "participant rows       : ${ROWS}"
echo "events.participant_count: ${COUNTER}"
echo

STATUS=0
[ "$SUCCEEDED" -eq "$CAPACITY" ] || { echo "FAIL: expected exactly ${CAPACITY} winners"; STATUS=1; }
[ "$ROWS" -eq "$CAPACITY" ]      || { echo "FAIL: expected ${CAPACITY} participant rows"; STATUS=1; }
[ "$COUNTER" -eq "$CAPACITY" ]   || { echo "FAIL: counter drifted from reality"; STATUS=1; }

if [ "$STATUS" -eq 0 ]; then
  echo "PASS: ${WORKERS} concurrent joiners, exactly ${CAPACITY} seats filled, no overbooking, counter consistent"
fi

rm -rf "${TMPDIR_RUN}"
exit "$STATUS"
