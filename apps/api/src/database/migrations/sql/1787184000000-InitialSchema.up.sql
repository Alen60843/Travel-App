-- ============================================================================
-- TripWith — Initial schema (Phase 1)
--
-- Hand-written SQL. This file is the canonical schema definition; the TypeORM
-- migration in ../1787184000000-InitialSchema.ts only executes it.
--
-- Conventions used throughout:
--   * UUID primary keys via gen_random_uuid() (PostgreSQL 13+ builtin).
--     BIGINT identity is used only for append-only high-volume log tables.
--   * All timestamps are timestamptz. There are no naive timestamps anywhere.
--   * Money is stored as integer minor units + ISO-4217 code. Never float.
--   * GEOGRAPHY(POINT,4326) for anything measured in metres.
--   * Soft deletion ONLY where a downstream record must survive the delete
--     (users, providers, messages, reviews). Ledgers are never soft-deleted.
--
-- PRIVACY INVARIANT (enforced structurally, see §"live location" below):
--   No table reachable from a discovery query stores a live GPS fix.
--   Live coordinates exist in exactly one place: sos_location_updates.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;      -- geography type, ST_DWithin, GIST opclasses
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets scalar columns join GIST composite indexes
CREATE EXTENSION IF NOT EXISTS intarray;     -- icount()/& for O(1)-ish Jaccard on interest_ids


-- ----------------------------------------------------------------------------
-- Enumerated types
--
-- Native ENUMs are used for closed domains that application code branches on
-- (statuses, kinds). Open, growing, editorially-managed domains (interests,
-- event/provider categories) are lookup TABLES instead — they carry icons,
-- labels and sort order, which an ENUM cannot.
-- ----------------------------------------------------------------------------
CREATE TYPE user_account_status AS ENUM (
  'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED'
);

CREATE TYPE trip_visibility AS ENUM ('PRIVATE', 'MATCHES_ONLY', 'PUBLIC');

CREATE TYPE event_status AS ENUM (
  'DRAFT', 'ACTIVE', 'FULL', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
);

CREATE TYPE event_visibility AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

CREATE TYPE event_host_type AS ENUM ('USER', 'PROVIDER');

-- PAYMENT_FAILED is distinct from CANCELLED on purpose: "the platform could not
-- take payment" and "the traveller changed their mind" drive different
-- notifications, different support handling, and potentially different trust
-- treatment. Conflating them would corrupt the audit trail.
CREATE TYPE join_request_status AS ENUM (
  'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED'
);

CREATE TYPE attendance_status AS ENUM ('UNKNOWN', 'ATTENDED', 'NO_SHOW', 'CANCELLED');

CREATE TYPE swipe_direction AS ENUM ('LIKE', 'PASS');

CREATE TYPE chat_room_type AS ENUM ('MATCH', 'EVENT', 'PROVIDER_INQUIRY');

CREATE TYPE message_type AS ENUM ('TEXT', 'IMAGE', 'LOCATION', 'SYSTEM');

-- Internal payment state. Deliberately NOT the provider's vocabulary — §21
-- requires internal status to be distinguishable from external status.
CREATE TYPE payment_status AS ENUM (
  'INITIATED', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED',
  'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED', 'FAILED'
);

CREATE TYPE payment_kind AS ENUM ('EVENT_DEPOSIT', 'PROVIDER_SUBSCRIPTION');

CREATE TYPE trust_event_type AS ENUM (
  'ACCOUNT_INIT', 'EVENT_ATTENDED', 'POSITIVE_REVIEW', 'NEGATIVE_REVIEW',
  'VERIFIED_NO_SHOW', 'MODERATION_ADJUSTMENT', 'REVERSAL'
);

CREATE TYPE review_target_type AS ENUM ('USER', 'PROVIDER');

CREATE TYPE moderation_state AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_FLAGGED');

CREATE TYPE report_target_type AS ENUM ('USER', 'EVENT', 'PROVIDER', 'REVIEW', 'MESSAGE');

CREATE TYPE report_status AS ENUM ('OPEN', 'UNDER_REVIEW', 'ACTIONED', 'DISMISSED');

CREATE TYPE restriction_type AS ENUM (
  'EVENT_CREATION_SUSPENDED', 'MATCHING_SUSPENDED',
  'MESSAGING_SUSPENDED', 'FULL_SUSPENSION'
);

CREATE TYPE sos_session_status AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

CREATE TYPE external_source AS ENUM ('GOOGLE_PLACES');

CREATE TYPE consent_type AS ENUM (
  'TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'MARKETING_EMAIL', 'LOCATION_PROCESSING'
);

CREATE TYPE media_kind AS ENUM ('IMAGE', 'VIDEO');

CREATE TYPE subscription_status AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');


-- ----------------------------------------------------------------------------
-- Shared trigger helpers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tw_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Applied to append-only ledgers. Auditability is worthless if rows can be
-- quietly rewritten, so the database refuses UPDATE/DELETE outright.
CREATE OR REPLACE FUNCTION tw_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only; corrections must be inserted as compensating rows',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;


-- ============================================================================
-- IDENTITY
-- ============================================================================

CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Firebase is the authentication authority. This column is the ONLY link to
  -- it, and is populated exclusively from a server-side verified ID token.
  firebase_uid          TEXT NOT NULL,
  email                 TEXT NOT NULL,
  email_verified_at     TIMESTAMPTZ,
  phone_e164            TEXT,

  account_status        user_account_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  date_of_birth         DATE NOT NULL,

  -- Trust score projection.
  --
  -- trust_score_raw is the UNCLAMPED running sum: 5.000 + SUM(ledger deltas).
  -- It is mutated only by the AFTER INSERT trigger on trust_score_events.
  -- The public score is derived by clamping the raw value.
  --
  -- Clamping the *stored* value after each event would be wrong: a user driven
  -- to -1.4 then given +0.2 would show 0.2 under incremental clamping, but
  -- clamp(5.0 + SUM(deltas)) is 0.0. Keeping the raw sum unclamped makes the
  -- projection exactly equal to a full replay of the ledger, at all times.
  trust_score_raw       NUMERIC(12,3) NOT NULL DEFAULT 5.000,
  trust_score           NUMERIC(5,2)
                          GENERATED ALWAYS AS (
                            LEAST(10.0, GREATEST(0.0, trust_score_raw))
                          ) STORED,

  last_active_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft delete justified: messages, reviews, payments and the trust ledger all
  -- reference users and must survive account closure. GDPR erasure is performed
  -- by anonymising this row, not by DELETE — financial records carry a statutory
  -- retention obligation that overrides the erasure right.
  deleted_at            TIMESTAMPTZ,

  CONSTRAINT users_email_format_chk
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_phone_e164_chk
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT users_dob_sane_chk
    CHECK (date_of_birth > DATE '1900-01-01'),
  -- Composite target for trip_segments' consistency FK (see trip_segments).
  CONSTRAINT users_id_dob_uk UNIQUE (id, date_of_birth)
);

CREATE UNIQUE INDEX users_firebase_uid_uk ON users (firebase_uid);
CREATE UNIQUE INDEX users_email_lower_uk  ON users (lower(email));
CREATE UNIQUE INDEX users_phone_uk        ON users (phone_e164) WHERE phone_e164 IS NOT NULL;

-- Candidate generation filters on (status, not deleted) before anything else.
CREATE INDEX users_discoverable_idx
  ON users (trust_score)
  WHERE account_status = 'ACTIVE' AND deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();

-- 18+ cannot be a CHECK constraint: PostgreSQL requires CHECK expressions to be
-- IMMUTABLE, and CURRENT_DATE is STABLE. A CHECK would also be re-evaluated at
-- restore time against the *restore* date, silently rejecting valid rows.
-- A trigger is the correct enforcement point.
CREATE OR REPLACE FUNCTION tw_enforce_minimum_age() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  min_age CONSTANT INT := 18;
BEGIN
  IF NEW.date_of_birth > (CURRENT_DATE - (min_age || ' years')::INTERVAL)::DATE THEN
    RAISE EXCEPTION 'account holder must be at least % years old', min_age
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_enforce_minimum_age
  BEFORE INSERT OR UPDATE OF date_of_birth ON users
  FOR EACH ROW EXECUTE FUNCTION tw_enforce_minimum_age();


CREATE TABLE user_profiles (
  user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  bio                   TEXT,
  avatar_url            TEXT,
  home_country_code     CHAR(2),
  native_language_code  TEXT,
  languages_spoken      TEXT[] NOT NULL DEFAULT '{}',

  -- 1 = backpacker … 5 = luxury (§7).
  travel_style          SMALLINT NOT NULL DEFAULT 3,

  -- Denormalised projection of user_interests, maintained by trigger.
  -- Exists so candidate generation can use an indexed array-overlap predicate
  -- (interest_ids && $1) instead of a join, and so exact Jaccard can be
  -- computed in SQL via intarray. user_interests remains the source of truth.
  interest_ids          INT[] NOT NULL DEFAULT '{}',

  identity_verified_at  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_profiles_display_name_chk
    CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 50),
  CONSTRAINT user_profiles_bio_chk
    CHECK (bio IS NULL OR char_length(bio) <= 1000),
  CONSTRAINT user_profiles_country_chk
    CHECK (home_country_code IS NULL OR home_country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT user_profiles_language_chk
    CHECK (native_language_code IS NULL OR native_language_code ~ '^[a-z]{2,3}$'),
  CONSTRAINT user_profiles_travel_style_chk
    CHECK (travel_style BETWEEN 1 AND 5)
);
-- NOTE: there is deliberately no `location`/`last_known_point` column here.
-- A traveller's live position is never part of their profile. See §PRIVACY.

CREATE INDEX user_profiles_interest_ids_idx
  ON user_profiles USING GIN (interest_ids gin__int_ops);
CREATE INDEX user_profiles_home_country_idx
  ON user_profiles (home_country_code) WHERE home_country_code IS NOT NULL;
CREATE INDEX user_profiles_travel_style_idx ON user_profiles (travel_style);

CREATE TRIGGER user_profiles_set_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


CREATE TABLE user_settings (
  user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Ghost Mode (§9): suppresses appearance in NEW swipe feeds only. It has no
  -- effect on matches, chat rooms or event membership — no FK or row is touched.
  ghost_mode_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  ghost_mode_until            TIMESTAMPTZ,

  discovery_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  trip_visibility             trip_visibility NOT NULL DEFAULT 'MATCHES_ONLY',

  -- Hard floor of 18 mirrors the account-level age policy: a preference can
  -- never widen the audience below the platform minimum.
  min_age_preference          SMALLINT NOT NULL DEFAULT 18,
  max_age_preference          SMALLINT NOT NULL DEFAULT 99,
  min_trust_score_preference  NUMERIC(5,2) NOT NULL DEFAULT 0,
  max_distance_km             INT NOT NULL DEFAULT 500,

  push_enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  locale                      TEXT NOT NULL DEFAULT 'en',
  timezone                    TEXT NOT NULL DEFAULT 'UTC',

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_settings_age_floor_chk   CHECK (min_age_preference >= 18),
  CONSTRAINT user_settings_age_ceiling_chk CHECK (max_age_preference <= 120),
  CONSTRAINT user_settings_age_order_chk   CHECK (min_age_preference <= max_age_preference),
  CONSTRAINT user_settings_trust_pref_chk  CHECK (min_trust_score_preference BETWEEN 0 AND 10),
  CONSTRAINT user_settings_distance_chk    CHECK (max_distance_km BETWEEN 1 AND 20000),
  CONSTRAINT user_settings_ghost_until_chk
    CHECK (ghost_mode_until IS NULL OR ghost_mode_enabled)
);

CREATE TRIGGER user_settings_set_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- GDPR consent ledger (EU-first baseline). Append-only: the current state of a
-- consent is the most recent row for (user_id, consent_type). Withdrawal is a
-- new row with granted = FALSE, never an UPDATE, because proving *when* consent
-- existed is the entire point of the record.
CREATE TABLE user_consents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type    consent_type NOT NULL,
  granted         BOOLEAN NOT NULL,
  policy_version  TEXT NOT NULL,
  source_ip       INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_consents_lookup_idx
  ON user_consents (user_id, consent_type, created_at DESC);

CREATE TRIGGER user_consents_append_only
  BEFORE UPDATE OR DELETE ON user_consents
  FOR EACH ROW EXECUTE FUNCTION tw_forbid_mutation();


-- ============================================================================
-- INTERESTS
-- ============================================================================

CREATE TABLE interests (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  grouping    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT interests_code_chk CHECK (code ~ '^[a-z0-9_]{2,40}$')
);

CREATE TABLE user_interests (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_id INT  NOT NULL REFERENCES interests(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, interest_id)
);

CREATE INDEX user_interests_interest_idx ON user_interests (interest_id);

-- Keeps user_profiles.interest_ids in lockstep with the join table. The array
-- is a cache; this trigger is what makes it safe to read.
CREATE OR REPLACE FUNCTION tw_sync_interest_ids() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_user UUID := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  UPDATE user_profiles p
     SET interest_ids = COALESCE(
           (SELECT array_agg(ui.interest_id ORDER BY ui.interest_id)
              FROM user_interests ui
             WHERE ui.user_id = target_user),
           '{}'::INT[]
         )
   WHERE p.user_id = target_user;
  RETURN NULL;
END $$;

CREATE TRIGGER user_interests_sync_projection
  AFTER INSERT OR DELETE ON user_interests
  FOR EACH ROW EXECUTE FUNCTION tw_sync_interest_ids();


-- ============================================================================
-- TRIPS  (normalised itinerary — §6)
-- ============================================================================

CREATE TABLE trips (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  visibility  trip_visibility NOT NULL DEFAULT 'MATCHES_ONLY',

  -- Flexible itinerary extras only. Anything searchable lives in columns (§6).
  metadata    JSONB NOT NULL DEFAULT '{}'::JSONB,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT trips_title_chk      CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT trips_date_order_chk CHECK (end_date >= start_date),
  -- Referenced by trip_segments to guarantee the denormalised user_id matches.
  CONSTRAINT trips_id_user_uk     UNIQUE (id, user_id)
);

CREATE INDEX trips_user_idx ON trips (user_id, start_date DESC);

CREATE TRIGGER trips_set_updated_at
  BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


CREATE TABLE trip_segments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id               UUID NOT NULL,

  -- Denormalised from trips so candidate generation never has to join trips.
  -- Consistency is guaranteed by the composite FK below, not by application
  -- code and not by a trigger.
  user_id               UUID NOT NULL,

  -- Google Place ID. Persistable long-term under Google's terms; it is an
  -- opaque identifier, not cached place *content*.
  destination_place_id  TEXT,
  destination_name      TEXT NOT NULL,
  country_code          CHAR(2),

  -- Destination centroid — a city/area the traveller intends to be in.
  -- This is NOT a GPS fix and is never derived from device location.
  location              GEOGRAPHY(POINT,4326) NOT NULL,

  start_date            DATE NOT NULL,
  end_date              DATE NOT NULL,

  -- Generated inclusive range. Overlap between two travellers becomes
  -- `a.date_range && b.date_range`, which a GIST index can answer directly.
  -- The equivalent two-column form (a.start <= b.end AND a.end >= b.start)
  -- cannot use an index for both bounds.
  date_range            DATERANGE
                          GENERATED ALWAYS AS (
                            daterange(start_date, end_date, '[]')
                          ) STORED,

  sort_order            SMALLINT NOT NULL DEFAULT 0,
  metadata              JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT trip_segments_trip_fk
    FOREIGN KEY (trip_id, user_id) REFERENCES trips(id, user_id) ON DELETE CASCADE,
  CONSTRAINT trip_segments_date_order_chk CHECK (end_date >= start_date),
  CONSTRAINT trip_segments_country_chk
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT trip_segments_name_chk
    CHECK (char_length(btrim(destination_name)) BETWEEN 1 AND 160)
);

CREATE INDEX trip_segments_trip_idx ON trip_segments (trip_id, sort_order);
CREATE INDEX trip_segments_user_idx ON trip_segments (user_id);
CREATE INDEX trip_segments_place_idx
  ON trip_segments (destination_place_id) WHERE destination_place_id IS NOT NULL;

-- Matching predicate index: ST_DWithin(location, $p, $r) AND date_range && $range
--
-- MEASURED, not assumed. scripts/benchmark-indexes.sql on 150k segments over 40
-- hubs (see docs/superpowers/specs/2026-08-20-tripwith-phase-1-design.md):
--
--   space+time  composite 0.276ms/326blk  vs  separate 0.995ms/426blk  (3.6x)
--               advantage holds 1.24x-5.48x across radius 10-200km and
--               date windows of 7-90 days, and widens with result size.
--   space only  composite 1.318ms  vs  standalone GIST(location) 1.597ms
--               -> the composite SUBSUMES a standalone spatial index.
--
-- So exactly one geography index is kept here. A standalone GIST(location) was
-- measured and dropped: it costs 10MB plus write amplification and wins nothing.
--
-- KNOWN GAP, accepted deliberately: a date-only predicate cannot use this
-- index's leading column and degrades to 7.295ms vs 1.508ms with a standalone
-- GIST(date_range). No Phase 1 access path filters segments by date without a
-- geographic anchor, so that 8.5MB index is not created. If a global
-- "anyone travelling in June" feed is ever introduced, add it back — the
-- payoff is known and this comment is the reason it is absent.
CREATE INDEX trip_segments_loc_range_gix ON trip_segments USING GIST (location, date_range);

CREATE TRIGGER trip_segments_set_updated_at
  BEFORE UPDATE ON trip_segments
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- ============================================================================
-- PROVIDERS  (marketplace supply side)
-- ============================================================================

CREATE TABLE provider_category_types (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  icon        TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  CONSTRAINT provider_category_types_code_chk CHECK (code ~ '^[a-z0-9_]{2,40}$')
);

CREATE TABLE providers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL for a record created by import/enrichment that nobody has claimed yet.
  owner_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,

  slug                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  description            TEXT,

  location               GEOGRAPHY(POINT,4326),
  address_line           TEXT,
  city                   TEXT,
  country_code           CHAR(2),

  website_url            TEXT,
  contact_phone_e164     TEXT,
  contact_email          TEXT,

  price_min_minor        INT,
  price_max_minor        INT,
  currency               CHAR(3) NOT NULL DEFAULT 'EUR',

  -- Rating projection, recomputed from reviews. Not authoritative.
  rating_avg             NUMERIC(3,2),
  rating_count           INT NOT NULL DEFAULT 0,

  verified_at            TIMESTAMPTZ,

  -- §11: imported data must never go live unreviewed. published_at cannot be
  -- set unless the owner has explicitly confirmed the profile — enforced below
  -- as a CHECK, so no code path can bypass it.
  confirmed_by_owner_at  TIMESTAMPTZ,
  published_at           TIMESTAMPTZ,

  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,

  CONSTRAINT providers_slug_chk     CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  CONSTRAINT providers_name_chk     CHECK (char_length(btrim(name)) BETWEEN 2 AND 160),
  CONSTRAINT providers_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT providers_country_chk  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT providers_price_order_chk
    CHECK (price_min_minor IS NULL OR price_max_minor IS NULL
           OR price_max_minor >= price_min_minor),
  CONSTRAINT providers_price_sign_chk
    CHECK ((price_min_minor IS NULL OR price_min_minor >= 0)
       AND (price_max_minor IS NULL OR price_max_minor >= 0)),
  CONSTRAINT providers_rating_chk
    CHECK (rating_avg IS NULL OR rating_avg BETWEEN 0 AND 5),
  CONSTRAINT providers_rating_count_chk CHECK (rating_count >= 0),
  CONSTRAINT providers_publish_requires_confirmation_chk
    CHECK (published_at IS NULL OR confirmed_by_owner_at IS NOT NULL)
);

CREATE UNIQUE INDEX providers_slug_uk ON providers (slug) WHERE deleted_at IS NULL;
CREATE INDEX providers_owner_idx ON providers (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Marketplace search only ever sees published, active, undeleted providers.
-- A partial GIST index keeps the spatial index small and hot.
CREATE INDEX providers_discoverable_gix
  ON providers USING GIST (location)
  WHERE published_at IS NOT NULL AND is_active AND deleted_at IS NULL;

CREATE INDEX providers_rating_idx
  ON providers (rating_avg DESC NULLS LAST)
  WHERE published_at IS NOT NULL AND is_active AND deleted_at IS NULL;

CREATE TRIGGER providers_set_updated_at
  BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- Provenance boundary (§10). TripWith-owned data lives in `providers`.
-- Externally-sourced data lives ONLY here, is never merged into provider
-- columns, and is composed at read time.
--
-- Deliberately NOT a raw payload dump. Only a fixed allowlist of fields is
-- persisted, each under a TTL. Ratings, review text, photos and any other
-- content whose storage the source's terms restrict are fetched live per
-- request and never written to disk. Adding a column here is a policy decision,
-- which is exactly why the shape is columns rather than JSONB.
CREATE TABLE provider_external_sources (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id               UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  source                    external_source NOT NULL,

  -- Google Place ID: an opaque identifier, storable long-term.
  external_id               TEXT NOT NULL,
  external_url              TEXT,
  attribution_text          TEXT,

  -- Allowlisted cached fields. Every one of these expires.
  cached_display_name       TEXT,
  cached_formatted_address  TEXT,
  cached_location           GEOGRAPHY(POINT,4326),
  cached_opening_hours      JSONB,

  cached_at                 TIMESTAMPTZ,
  cache_expires_at          TIMESTAMPTZ,
  last_refresh_attempt_at   TIMESTAMPTZ,
  refresh_failure_count     INT NOT NULL DEFAULT 0,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT provider_external_sources_source_uk UNIQUE (source, external_id),
  CONSTRAINT provider_external_sources_provider_uk UNIQUE (provider_id, source),
  CONSTRAINT provider_external_sources_cache_chk
    CHECK (cached_at IS NULL OR cache_expires_at IS NULL OR cache_expires_at > cached_at),
  CONSTRAINT provider_external_sources_ttl_required_chk
    CHECK (cached_at IS NULL OR cache_expires_at IS NOT NULL),
  CONSTRAINT provider_external_sources_failures_chk CHECK (refresh_failure_count >= 0)
);

-- Drives the BullMQ refresh job: "which cached rows are about to expire?"
CREATE INDEX provider_external_sources_expiry_idx
  ON provider_external_sources (cache_expires_at)
  WHERE cache_expires_at IS NOT NULL;

CREATE TRIGGER provider_external_sources_set_updated_at
  BEFORE UPDATE ON provider_external_sources
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- First-party media only: files TripWith holds in its own object storage.
-- Third-party photo URLs are never persisted here.
CREATE TABLE provider_media (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind                media_kind NOT NULL DEFAULT 'IMAGE',
  storage_key         TEXT NOT NULL,
  width_px            INT,
  height_px           INT,
  byte_size           BIGINT,
  sort_order          SMALLINT NOT NULL DEFAULT 0,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  moderation_state    moderation_state NOT NULL DEFAULT 'PENDING',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,

  CONSTRAINT provider_media_storage_key_uk UNIQUE (storage_key),
  CONSTRAINT provider_media_dims_chk
    CHECK ((width_px IS NULL OR width_px > 0) AND (height_px IS NULL OR height_px > 0)),
  CONSTRAINT provider_media_size_chk CHECK (byte_size IS NULL OR byte_size > 0)
);

CREATE INDEX provider_media_provider_idx
  ON provider_media (provider_id, sort_order) WHERE deleted_at IS NULL;


-- Providers are many-to-many with categories (a hostel can run treks and taxis).
-- Events, by contrast, carry exactly one category, so events use a direct FK.
CREATE TABLE provider_categories (
  provider_id  UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  category_id  INT  NOT NULL REFERENCES provider_category_types(id) ON DELETE RESTRICT,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, category_id)
);

CREATE INDEX provider_categories_category_idx ON provider_categories (category_id);
-- At most one primary category per provider.
CREATE UNIQUE INDEX provider_categories_one_primary_uk
  ON provider_categories (provider_id) WHERE is_primary;


CREATE TABLE provider_subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id               UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  plan_code                 TEXT NOT NULL,
  status                    subscription_status NOT NULL DEFAULT 'TRIALING',
  price_minor               INT NOT NULL,
  currency                  CHAR(3) NOT NULL DEFAULT 'EUR',
  current_period_start      TIMESTAMPTZ NOT NULL,
  current_period_end        TIMESTAMPTZ NOT NULL,
  cancel_at                 TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  external_subscription_id  TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT provider_subscriptions_period_chk
    CHECK (current_period_end > current_period_start),
  CONSTRAINT provider_subscriptions_price_chk CHECK (price_minor >= 0),
  CONSTRAINT provider_subscriptions_currency_chk CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX provider_subscriptions_external_uk
  ON provider_subscriptions (external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
-- One live subscription per provider.
CREATE UNIQUE INDEX provider_subscriptions_active_uk
  ON provider_subscriptions (provider_id)
  WHERE status IN ('TRIALING', 'ACTIVE', 'PAST_DUE');

CREATE TRIGGER provider_subscriptions_set_updated_at
  BEFORE UPDATE ON provider_subscriptions
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- ============================================================================
-- EVENTS
-- ============================================================================

CREATE TABLE event_categories (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  icon        TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  CONSTRAINT event_categories_code_chk CHECK (code ~ '^[a-z0-9_]{2,40}$')
);

CREATE TABLE events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  host_type             event_host_type NOT NULL,
  host_user_id          UUID REFERENCES users(id) ON DELETE RESTRICT,
  host_provider_id      UUID REFERENCES providers(id) ON DELETE RESTRICT,

  category_id           INT NOT NULL REFERENCES event_categories(id) ON DELETE RESTRICT,
  title                 TEXT NOT NULL,
  description           TEXT,

  status                event_status NOT NULL DEFAULT 'DRAFT',
  visibility            event_visibility NOT NULL DEFAULT 'PUBLIC',

  capacity_max          INT NOT NULL,
  -- Maintained exclusively by trigger from event_participants. Combined with
  -- the capacity CHECK below, over-booking the final slot is impossible at the
  -- storage layer regardless of what application code does.
  participant_count     INT NOT NULL DEFAULT 0,

  price_minor           INT NOT NULL DEFAULT 0,
  deposit_minor         INT NOT NULL DEFAULT 0,
  currency              CHAR(3) NOT NULL DEFAULT 'EUR',

  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,
  time_range            TSTZRANGE
                          GENERATED ALWAYS AS (
                            tstzrange(starts_at, ends_at, '[)')
                          ) STORED,

  -- A public meeting point deliberately chosen by the host. This is the only
  -- kind of coordinate Explorer ever reads.
  meeting_point         GEOGRAPHY(POINT,4326) NOT NULL,
  meeting_point_label   TEXT,

  min_trust_score       NUMERIC(5,2) NOT NULL DEFAULT 0,
  join_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  cancellation_policy   TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,

  CONSTRAINT events_host_exclusive_chk CHECK (
    (host_type = 'USER'     AND host_user_id IS NOT NULL AND host_provider_id IS NULL) OR
    (host_type = 'PROVIDER' AND host_provider_id IS NOT NULL AND host_user_id IS NULL)
  ),
  CONSTRAINT events_title_chk     CHECK (char_length(btrim(title)) BETWEEN 3 AND 140),
  CONSTRAINT events_capacity_chk  CHECK (capacity_max BETWEEN 1 AND 10000),
  CONSTRAINT events_participant_count_chk CHECK (participant_count >= 0),
  CONSTRAINT events_capacity_not_exceeded_chk CHECK (participant_count <= capacity_max),
  CONSTRAINT events_price_chk     CHECK (price_minor >= 0),
  CONSTRAINT events_deposit_chk   CHECK (deposit_minor >= 0 AND deposit_minor <= price_minor),
  CONSTRAINT events_currency_chk  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT events_time_order_chk CHECK (ends_at > starts_at),
  CONSTRAINT events_trust_gate_chk CHECK (min_trust_score BETWEEN 0 AND 10),
  CONSTRAINT events_cancelled_consistency_chk
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT events_completed_consistency_chk
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

-- Explorer's primary index: "public, joinable events near me, in this window".
--
-- Partial on exactly the rows Explorer may return, which keeps the GIST tree a
-- fraction of full-table size, and composite so space and time resolve in one
-- scan. Measured on 100k events (scripts/benchmark-indexes.sql):
--
--   space+time  composite 0.073ms/40blk  vs  spatial-only 0.230ms/731blk
--               -> 3.2x faster, 18x less buffer traffic.
--   space only  composite 0.493ms  vs  spatial-only 0.400ms
--
-- A standalone partial GIST(meeting_point) was measured and dropped: it wins
-- only the rare no-time-filter case by ~0.09ms while costing 5.5MB and extra
-- write churn on a table whose status column changes throughout the lifecycle.
CREATE INDEX events_discoverable_geo_time_gix
  ON events USING GIST (meeting_point, time_range)
  WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL');

CREATE INDEX events_status_starts_idx   ON events (status, starts_at);
CREATE INDEX events_category_starts_idx ON events (category_id, starts_at)
  WHERE visibility = 'PUBLIC' AND status IN ('ACTIVE', 'FULL');
CREATE INDEX events_host_user_idx       ON events (host_user_id) WHERE host_user_id IS NOT NULL;
CREATE INDEX events_host_provider_idx   ON events (host_provider_id) WHERE host_provider_id IS NOT NULL;
-- Drives the lifecycle transition jobs (ACTIVE -> IN_PROGRESS -> COMPLETED).
CREATE INDEX events_lifecycle_idx ON events (starts_at)
  WHERE status IN ('ACTIVE', 'FULL', 'IN_PROGRESS');

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- Audit trail (§12). Written by trigger, so a transition cannot happen without
-- being recorded — the history is not dependent on service-layer discipline.
CREATE TABLE event_status_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  from_status    event_status,
  to_status      event_status NOT NULL,
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system job
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX event_status_history_event_idx ON event_status_history (event_id, created_at DESC);

CREATE TRIGGER event_status_history_append_only
  BEFORE UPDATE OR DELETE ON event_status_history
  FOR EACH ROW EXECUTE FUNCTION tw_forbid_mutation();

-- The set of legal transitions (§12). Enforced here as a last line of defence;
-- the service layer owns the richer state machine (permissions, side effects).
CREATE OR REPLACE FUNCTION tw_event_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed CONSTANT TEXT[] := ARRAY[
    'DRAFT>ACTIVE', 'DRAFT>CANCELLED',
    'ACTIVE>FULL', 'ACTIVE>IN_PROGRESS', 'ACTIVE>CANCELLED',
    'FULL>ACTIVE', 'FULL>IN_PROGRESS', 'FULL>CANCELLED',
    'IN_PROGRESS>COMPLETED', 'IN_PROGRESS>CANCELLED'
  ];
  transition TEXT := OLD.status::TEXT || '>' || NEW.status::TEXT;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (transition = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal event status transition %', transition
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO event_status_history (event_id, from_status, to_status, actor_user_id, reason)
  VALUES (
    NEW.id,
    OLD.status,
    NEW.status,
    NULLIF(current_setting('tripwith.actor_user_id', TRUE), '')::UUID,
    NULLIF(current_setting('tripwith.transition_reason', TRUE), '')
  );

  RETURN NEW;
END $$;

CREATE TRIGGER events_status_guard
  BEFORE UPDATE OF status ON events
  FOR EACH ROW EXECUTE FUNCTION tw_event_status_guard();

-- Seeds the history with the creation state so the audit chain has no gap.
CREATE OR REPLACE FUNCTION tw_event_status_seed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO event_status_history (event_id, from_status, to_status, actor_user_id, reason)
  VALUES (NEW.id, NULL, NEW.status, NEW.host_user_id, 'created');
  RETURN NULL;
END $$;

CREATE TRIGGER events_status_seed
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION tw_event_status_seed();


-- ============================================================================
-- PAYMENTS  (schema only — no provider implementation in Phase 1)
-- ============================================================================

CREATE TABLE payments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind                        payment_kind NOT NULL,
  event_id                    UUID REFERENCES events(id) ON DELETE RESTRICT,
  provider_subscription_id    UUID REFERENCES provider_subscriptions(id) ON DELETE RESTRICT,

  -- Provider-agnostic. 'stripe' is one value, never a schema assumption.
  provider                    TEXT NOT NULL,
  provider_payment_intent_id  TEXT,

  -- Internal state machine, owned by TripWith.
  status                      payment_status NOT NULL DEFAULT 'INITIATED',
  -- Verbatim external state, for reconciliation and support. Never branched on.
  provider_status             TEXT,

  amount_minor                INT NOT NULL,
  currency                    CHAR(3) NOT NULL DEFAULT 'EUR',
  captured_amount_minor       INT NOT NULL DEFAULT 0,
  refunded_amount_minor       INT NOT NULL DEFAULT 0,

  -- §20: persisted rather than assumed. Authorization windows differ per
  -- provider and per payment method; the expiry job reads this column.
  authorization_expires_at    TIMESTAMPTZ,
  -- PSD2/SCA: an authorization may pause for a 3DS challenge.
  requires_action             BOOLEAN NOT NULL DEFAULT FALSE,

  -- Distinguishes "authorized, host has not decided yet" from "capture asked
  -- for, outcome unknown". Without it, a crash mid-capture is indistinguishable
  -- from an untouched authorization and nothing knows to reconcile.
  capture_requested_at        TIMESTAMPTZ,

  -- Deterministic and written BEFORE the provider is ever called.
  --
  -- The row is INSERTed with status INITIATED and this key, and only then is
  -- authorize() invoked with the same key. So a crash between the provider
  -- call and the status update leaves an INITIATED row that the reconciler
  -- finds and resolves via getPaymentStatus(idempotency_key) — either
  -- adopting the authorization or cancelling it. There is no ordering in
  -- which money moves without a PostgreSQL row describing the intent.
  idempotency_key             TEXT NOT NULL,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorized_at               TIMESTAMPTZ,
  captured_at                 TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,

  CONSTRAINT payments_amount_chk    CHECK (amount_minor > 0),
  CONSTRAINT payments_currency_chk  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payments_captured_chk
    CHECK (captured_amount_minor >= 0 AND captured_amount_minor <= amount_minor),
  CONSTRAINT payments_refunded_chk
    CHECK (refunded_amount_minor >= 0 AND refunded_amount_minor <= captured_amount_minor),
  CONSTRAINT payments_kind_target_chk CHECK (
    (kind = 'EVENT_DEPOSIT'         AND event_id IS NOT NULL AND provider_subscription_id IS NULL) OR
    (kind = 'PROVIDER_SUBSCRIPTION' AND provider_subscription_id IS NOT NULL AND event_id IS NULL)
  ),
  -- Capture cannot be requested against something never authorized.
  CONSTRAINT payments_capture_after_auth_chk
    CHECK (capture_requested_at IS NULL OR authorized_at IS NOT NULL),
  CONSTRAINT payments_idempotency_uk UNIQUE (idempotency_key)
);

CREATE UNIQUE INDEX payments_provider_intent_uk
  ON payments (provider, provider_payment_intent_id)
  WHERE provider_payment_intent_id IS NOT NULL;

CREATE INDEX payments_user_idx  ON payments (user_id, created_at DESC);
CREATE INDEX payments_event_idx ON payments (event_id) WHERE event_id IS NOT NULL;
-- Drives the authorization-expiry sweep.
CREATE INDEX payments_expiring_auth_idx
  ON payments (authorization_expires_at)
  WHERE status IN ('AUTHORIZED', 'REQUIRES_ACTION') AND authorization_expires_at IS NOT NULL;

-- Reconciliation queue 1: intents whose provider outcome is unknown.
-- An INITIATED row older than the reconcile threshold means the process died
-- somewhere around the authorize() call. The reconciler asks the provider what
-- actually happened, keyed by idempotency_key, and either adopts or cancels.
-- This is what prevents a permanently orphaned external authorization.
CREATE INDEX payments_unconfirmed_intent_idx
  ON payments (created_at) WHERE status = 'INITIATED';

-- Reconciliation queue 2: captures asked for but not confirmed.
CREATE INDEX payments_unconfirmed_capture_idx
  ON payments (capture_requested_at)
  WHERE capture_requested_at IS NOT NULL
    AND status IN ('AUTHORIZED', 'REQUIRES_ACTION');

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- Webhook idempotency (§4.4, §21). The handler INSERTs here first with
-- ON CONFLICT DO NOTHING inside the same transaction as the state change;
-- zero rows affected means "already processed", so the handler returns 200
-- without repeating side effects.
CREATE TABLE payment_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID REFERENCES payments(id) ON DELETE RESTRICT,  -- may be unmapped on arrival
  provider            TEXT NOT NULL,
  provider_event_id   TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  signature_verified  BOOLEAN NOT NULL,
  payload             JSONB NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  processing_error    TEXT,

  CONSTRAINT payment_events_provider_event_uk UNIQUE (provider, provider_event_id)
);

CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, received_at DESC);
CREATE INDEX payment_events_unprocessed_idx ON payment_events (received_at)
  WHERE processed_at IS NULL;


-- ============================================================================
-- EVENT PARTICIPATION
-- ============================================================================

CREATE TABLE event_join_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              join_request_status NOT NULL DEFAULT 'PENDING',
  payment_id          UUID REFERENCES payments(id) ON DELETE SET NULL,
  message             TEXT,

  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  approved_at         TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  expired_at          TIMESTAMPTZ,
  decided_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT event_join_requests_expiry_chk CHECK (expires_at > requested_at),
  CONSTRAINT event_join_requests_message_chk
    CHECK (message IS NULL OR char_length(message) <= 500),
  CONSTRAINT event_join_requests_status_timestamps_chk CHECK (
    (status <> 'APPROVED'  OR approved_at  IS NOT NULL) AND
    (status <> 'REJECTED'  OR rejected_at  IS NOT NULL) AND
    (status <> 'CANCELLED' OR cancelled_at IS NOT NULL) AND
    (status <> 'EXPIRED'   OR expired_at   IS NOT NULL)
  ),
  CONSTRAINT event_join_requests_payment_uk UNIQUE (payment_id)
);

-- §13: a user may hold at most one *live* request per event. Rejected/expired
-- rows stay for audit and permit a later re-request.
CREATE UNIQUE INDEX event_join_requests_active_uk
  ON event_join_requests (event_id, user_id)
  WHERE status IN ('PENDING', 'APPROVED');

CREATE INDEX event_join_requests_event_idx ON event_join_requests (event_id, status);
CREATE INDEX event_join_requests_user_idx  ON event_join_requests (user_id, created_at DESC);
-- Drives the 24h expiry job (§20).
CREATE INDEX event_join_requests_expiry_idx
  ON event_join_requests (expires_at) WHERE status = 'PENDING';

CREATE TRIGGER event_join_requests_set_updated_at
  BEFORE UPDATE ON event_join_requests
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();

-- Money-safety gate on approval.
--
-- Approving a request consumes a seat (the participant insert increments
-- capacity). For a paid event that seat must not be given away before funds
-- are actually secured. A CHECK cannot express this because it spans three
-- tables, so it is a trigger — and it lives in the database rather than the
-- service because "seat granted without an authorization" is the kind of bug
-- that only shows up under a partial failure, which is exactly when service
-- code is least trustworthy.
--
-- Free events (deposit_minor = 0) are unaffected.
CREATE OR REPLACE FUNCTION tw_guard_join_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  required_deposit INT;
  pay_status       payment_status;
BEGIN
  IF NEW.status <> 'APPROVED' OR OLD.status = 'APPROVED' THEN
    RETURN NEW;
  END IF;

  SELECT e.deposit_minor INTO required_deposit
    FROM events e WHERE e.id = NEW.event_id;

  IF COALESCE(required_deposit, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_id IS NULL THEN
    RAISE EXCEPTION
      'join request % for a paid event cannot be approved without a payment',
      NEW.id USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.status INTO pay_status FROM payments p WHERE p.id = NEW.payment_id;

  IF pay_status IS NULL OR pay_status NOT IN ('AUTHORIZED', 'CAPTURED') THEN
    RAISE EXCEPTION
      'join request % cannot be approved: payment is %, expected AUTHORIZED or CAPTURED',
      NEW.id, COALESCE(pay_status::TEXT, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER event_join_requests_guard_approval
  BEFORE UPDATE OF status ON event_join_requests
  FOR EACH ROW EXECUTE FUNCTION tw_guard_join_approval();


CREATE TABLE event_participants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  join_request_id    UUID REFERENCES event_join_requests(id) ON DELETE SET NULL,
  payment_id         UUID REFERENCES payments(id) ON DELETE SET NULL,

  is_host            BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  attendance_status  attendance_status NOT NULL DEFAULT 'UNKNOWN',
  checked_in_at      TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT event_participants_join_request_uk UNIQUE (join_request_id),
  CONSTRAINT event_participants_cancel_consistency_chk
    CHECK ((attendance_status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

-- §4.2: at most one ACTIVE participation per (event, user).
--
-- Partial rather than a plain UNIQUE constraint (which cannot carry a WHERE
-- clause, hence an index) so that a cancelled participation stays on the table
-- as audit history without permanently barring the user from the event.
--
-- This matters for the compensation path: when a capture fails permanently the
-- participant is cancelled and the seat returns to inventory. Under an
-- unconditional UNIQUE the user could never rejoin an event that still had
-- room, purely because their card failed once.
--
-- Duplicate seat counting remains impossible because tw_sync_participant_count
-- only counts rows with cancelled_at IS NULL, and concurrency safety is
-- unchanged: uniqueness is still enforced by the index.
CREATE UNIQUE INDEX event_participants_active_uk
  ON event_participants (event_id, user_id) WHERE cancelled_at IS NULL;

CREATE INDEX event_participants_user_idx  ON event_participants (user_id, joined_at DESC);
CREATE INDEX event_participants_event_idx ON event_participants (event_id)
  WHERE cancelled_at IS NULL;

CREATE TRIGGER event_participants_set_updated_at
  BEFORE UPDATE ON event_participants
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();

-- Capacity accounting.
--
-- This is what solves the concurrent-last-slot problem. Two transactions each
-- inserting the final participant both reach this UPDATE; PostgreSQL serialises
-- them on the events row lock, the second re-reads the incremented count under
-- READ COMMITTED, and events_capacity_not_exceeded_chk rejects it. No
-- application-level lock is required for correctness.
CREATE OR REPLACE FUNCTION tw_sync_participant_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  delta INT := 0;
  target UUID := COALESCE(NEW.event_id, OLD.event_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := CASE WHEN NEW.cancelled_at IS NULL THEN 1 ELSE 0 END;
  ELSIF TG_OP = 'DELETE' THEN
    delta := CASE WHEN OLD.cancelled_at IS NULL THEN -1 ELSE 0 END;
  ELSE
    delta := CASE WHEN NEW.cancelled_at IS NULL THEN 1 ELSE 0 END
           - CASE WHEN OLD.cancelled_at IS NULL THEN 1 ELSE 0 END;
  END IF;

  IF delta <> 0 THEN
    UPDATE events SET participant_count = participant_count + delta WHERE id = target;
  END IF;

  RETURN NULL;
END $$;

CREATE TRIGGER event_participants_sync_count
  AFTER INSERT OR UPDATE OF cancelled_at OR DELETE ON event_participants
  FOR EACH ROW EXECUTE FUNCTION tw_sync_participant_count();


-- ============================================================================
-- SOCIAL MATCHING
-- ============================================================================

CREATE TABLE swipes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction       swipe_direction NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT swipes_pair_uk UNIQUE (source_user_id, target_user_id),
  CONSTRAINT swipes_no_self_chk CHECK (source_user_id <> target_user_id)
);

-- Anti-join in candidate generation: "users I have already swiped".
CREATE INDEX swipes_source_idx ON swipes (source_user_id, target_user_id);
-- Reciprocity probe on swipe: "has the target already liked me?"
CREATE INDEX swipes_incoming_likes_idx
  ON swipes (target_user_id, source_user_id) WHERE direction = 'LIKE';


CREATE TABLE chat_rooms (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             chat_room_type NOT NULL,
  event_id         UUID REFERENCES events(id) ON DELETE CASCADE,
  provider_id      UUID REFERENCES providers(id) ON DELETE CASCADE,

  -- Monotonic per-room message counter. Unread counts are
  -- (chat_rooms.last_seq - chat_members.last_read_seq): O(1), no COUNT(*).
  last_seq         BIGINT NOT NULL DEFAULT 0,
  last_message_at  TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chat_rooms_last_seq_chk CHECK (last_seq >= 0),
  CONSTRAINT chat_rooms_context_chk CHECK (
    (type = 'MATCH'            AND event_id IS NULL AND provider_id IS NULL) OR
    (type = 'EVENT'            AND event_id IS NOT NULL AND provider_id IS NULL) OR
    (type = 'PROVIDER_INQUIRY' AND provider_id IS NOT NULL AND event_id IS NULL)
  )
);

-- Exactly one group room per event.
CREATE UNIQUE INDEX chat_rooms_event_uk ON chat_rooms (event_id) WHERE type = 'EVENT';

CREATE TRIGGER chat_rooms_set_updated_at
  BEFORE UPDATE ON chat_rooms
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


CREATE TABLE matches (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical ordering (user_a_id < user_b_id) is what makes the UNIQUE
  -- constraint total: without it, (X,Y) and (Y,X) would be two legal rows and
  -- duplicate matches would be possible under concurrency.
  user_a_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  chat_room_id         UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE RESTRICT,
  matched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  unmatched_at         TIMESTAMPTZ,
  unmatched_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT matches_pair_uk      UNIQUE (user_a_id, user_b_id),
  CONSTRAINT matches_room_uk      UNIQUE (chat_room_id),
  CONSTRAINT matches_canonical_chk CHECK (user_a_id < user_b_id)
);

CREATE INDEX matches_user_a_idx ON matches (user_a_id) WHERE unmatched_at IS NULL;
CREATE INDEX matches_user_b_idx ON matches (user_b_id) WHERE unmatched_at IS NULL;


CREATE TABLE chat_members (
  room_id        UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at        TIMESTAMPTZ,
  last_read_seq  BIGINT NOT NULL DEFAULT 0,
  muted_until    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (room_id, user_id),
  CONSTRAINT chat_members_read_seq_chk CHECK (last_read_seq >= 0)
);

CREATE INDEX chat_members_user_idx ON chat_members (user_id) WHERE left_at IS NULL;

CREATE TRIGGER chat_members_set_updated_at
  BEFORE UPDATE ON chat_members
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


CREATE TABLE messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id            UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,

  -- Assigned by trigger from chat_rooms.last_seq. Gapless and totally ordered
  -- within a room, which timestamps are not (clock skew, ties).
  seq                BIGINT NOT NULL,

  sender_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL for SYSTEM
  type               message_type NOT NULL DEFAULT 'TEXT',
  body               TEXT,
  media_storage_key  TEXT,

  -- User-initiated point share inside a conversation. Explicit, one-shot, and
  -- never read by any discovery query. Distinct from passive tracking.
  shared_location    GEOGRAPHY(POINT,4326),

  -- Client-supplied dedupe key; makes send-retry safe over flaky mobile links.
  client_message_id  TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at          TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,  -- soft: moderation must retain evidence

  CONSTRAINT messages_room_seq_uk UNIQUE (room_id, seq),
  CONSTRAINT messages_seq_chk CHECK (seq > 0),
  CONSTRAINT messages_body_chk CHECK (
    (type <> 'TEXT') OR (body IS NOT NULL AND char_length(body) BETWEEN 1 AND 4000)
  ),
  CONSTRAINT messages_media_chk CHECK ((type <> 'IMAGE') OR media_storage_key IS NOT NULL),
  CONSTRAINT messages_location_chk CHECK ((type <> 'LOCATION') OR shared_location IS NOT NULL),
  CONSTRAINT messages_sender_chk CHECK ((type = 'SYSTEM') OR sender_user_id IS NOT NULL)
);

-- Keyset pagination: WHERE room_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT n
CREATE INDEX messages_room_seq_idx ON messages (room_id, seq DESC);
CREATE UNIQUE INDEX messages_client_dedupe_uk
  ON messages (room_id, sender_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- Allocates seq and advances the room cursor. The UPDATE takes the room's row
-- lock, so concurrent senders serialise and seq is never duplicated or skipped.
CREATE OR REPLACE FUNCTION tw_assign_message_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_seq BIGINT;
BEGIN
  UPDATE chat_rooms
     SET last_seq = last_seq + 1,
         last_message_at = now()
   WHERE id = NEW.room_id
  RETURNING last_seq INTO next_seq;

  IF next_seq IS NULL THEN
    RAISE EXCEPTION 'chat room % does not exist', NEW.room_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.seq := next_seq;
  RETURN NEW;
END $$;

CREATE TRIGGER messages_assign_seq
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION tw_assign_message_seq();


-- ============================================================================
-- TRUST, REVIEWS, MODERATION
-- ============================================================================

CREATE TABLE reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type         review_target_type NOT NULL,
  target_user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  target_provider_id  UUID REFERENCES providers(id) ON DELETE CASCADE,
  event_id            UUID REFERENCES events(id) ON DELETE SET NULL,

  rating              SMALLINT NOT NULL,
  body                TEXT,

  -- TRUE only when the reviewer was a confirmed participant of event_id.
  -- Unverified reviews never produce a trust delta (§15 anti-abuse).
  is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_state    moderation_state NOT NULL DEFAULT 'PENDING',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,

  CONSTRAINT reviews_rating_chk CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT reviews_body_chk   CHECK (body IS NULL OR char_length(body) <= 2000),
  CONSTRAINT reviews_target_chk CHECK (
    (target_type = 'USER'     AND target_user_id IS NOT NULL AND target_provider_id IS NULL) OR
    (target_type = 'PROVIDER' AND target_provider_id IS NOT NULL AND target_user_id IS NULL)
  ),
  -- §15: nobody reviews themselves.
  CONSTRAINT reviews_no_self_chk
    CHECK (target_user_id IS NULL OR target_user_id <> reviewer_user_id),
  -- A verified review must have an event to be verified against.
  CONSTRAINT reviews_verified_needs_event_chk
    CHECK (NOT is_verified OR event_id IS NOT NULL)
);

-- §4.2: one review per (reviewer, event, reviewee). Expressed as partial unique
-- indexes because the tuple contains NULLs in the non-event case.
CREATE UNIQUE INDEX reviews_user_per_event_uk
  ON reviews (reviewer_user_id, event_id, target_user_id)
  WHERE target_type = 'USER' AND event_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX reviews_provider_per_event_uk
  ON reviews (reviewer_user_id, event_id, target_provider_id)
  WHERE target_type = 'PROVIDER' AND event_id IS NOT NULL AND deleted_at IS NULL;

-- One standing (non-event) review per reviewer/provider pair.
CREATE UNIQUE INDEX reviews_provider_standalone_uk
  ON reviews (reviewer_user_id, target_provider_id)
  WHERE target_type = 'PROVIDER' AND event_id IS NULL AND deleted_at IS NULL;

CREATE INDEX reviews_target_user_idx
  ON reviews (target_user_id, created_at DESC)
  WHERE moderation_state = 'APPROVED' AND deleted_at IS NULL;
CREATE INDEX reviews_target_provider_idx
  ON reviews (target_provider_id, created_at DESC)
  WHERE moderation_state = 'APPROVED' AND deleted_at IS NULL;
CREATE INDEX reviews_moderation_queue_idx
  ON reviews (created_at) WHERE moderation_state IN ('PENDING', 'AUTO_FLAGGED');

CREATE TRIGGER reviews_set_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();

-- Marketplace rating projection.
--
-- providers.rating_avg / rating_count are TripWith-native: computed only from
-- TripWith reviews that are APPROVED and not deleted. Google's rating is never
-- an input — it has no column in this schema and is not persisted at all — so
-- Marketplace filtering and ranking run entirely on first-party data.
--
-- Maintained by trigger rather than by application code so the projection
-- cannot drift when moderation approves, rejects or removes a review.
CREATE OR REPLACE FUNCTION tw_sync_provider_rating() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target UUID := COALESCE(NEW.target_provider_id, OLD.target_provider_id);
BEGIN
  IF target IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE providers p
     SET rating_avg = sub.avg_rating,
         rating_count = sub.n
    FROM (
      SELECT round(avg(r.rating)::NUMERIC, 2) AS avg_rating,
             count(*)                          AS n
        FROM reviews r
       WHERE r.target_provider_id = target
         AND r.target_type = 'PROVIDER'
         AND r.moderation_state = 'APPROVED'
         AND r.deleted_at IS NULL
    ) sub
   WHERE p.id = target;

  RETURN NULL;
END $$;

-- Fires on every transition that can change which reviews count toward the
-- projection: creation, removal, rating edits, moderation decisions, and
-- soft deletion.
CREATE TRIGGER reviews_sync_provider_rating
  AFTER INSERT OR DELETE
      OR UPDATE OF rating, moderation_state, deleted_at, target_provider_id
  ON reviews
  FOR EACH ROW EXECUTE FUNCTION tw_sync_provider_rating();


-- The trust ledger. Append-only and the sole source of truth for trust.
CREATE TABLE trust_score_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- subject
  source_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,          -- counterparty
  event_id           UUID REFERENCES events(id) ON DELETE SET NULL,
  review_id          UUID REFERENCES reviews(id) ON DELETE SET NULL,

  type               trust_event_type NOT NULL,
  delta              NUMERIC(6,3) NOT NULL,
  reason             TEXT,

  -- Moderation reverses by inserting a compensating row that points at the
  -- original. Nothing is ever edited or removed.
  reverses_event_id  UUID REFERENCES trust_score_events(id) ON DELETE RESTRICT,

  -- §4.4: replaying the same domain occurrence cannot double-count.
  idempotency_key    TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT trust_score_events_idempotency_uk UNIQUE (idempotency_key),
  CONSTRAINT trust_score_events_delta_chk CHECK (delta BETWEEN -10 AND 10),
  CONSTRAINT trust_score_events_no_self_chk
    CHECK (source_user_id IS NULL OR source_user_id <> user_id),
  CONSTRAINT trust_score_events_reversal_chk
    CHECK (type <> 'REVERSAL' OR reverses_event_id IS NOT NULL)
);

CREATE INDEX trust_score_events_user_idx ON trust_score_events (user_id, created_at DESC);
CREATE INDEX trust_score_events_event_idx ON trust_score_events (event_id)
  WHERE event_id IS NOT NULL;
-- Detects reciprocal boosting rings between the same pair of accounts.
CREATE INDEX trust_score_events_pair_idx
  ON trust_score_events (source_user_id, user_id, created_at DESC)
  WHERE source_user_id IS NOT NULL;
CREATE UNIQUE INDEX trust_score_events_reversal_uk
  ON trust_score_events (reverses_event_id) WHERE reverses_event_id IS NOT NULL;

CREATE TRIGGER trust_score_events_append_only
  BEFORE UPDATE OR DELETE ON trust_score_events
  FOR EACH ROW EXECUTE FUNCTION tw_forbid_mutation();

-- The ONLY writer of users.trust_score_raw. Because the raw column is an
-- unclamped running total and the public score is a generated clamp of it,
-- users.trust_score is always exactly clamp(5.0 + SUM(ledger.delta)).
-- Updating the score without a ledger row is therefore impossible by
-- construction, not by convention.
CREATE OR REPLACE FUNCTION tw_apply_trust_delta() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users
     SET trust_score_raw = trust_score_raw + NEW.delta
   WHERE id = NEW.user_id;
  RETURN NULL;
END $$;

CREATE TRIGGER trust_score_events_apply
  AFTER INSERT ON trust_score_events
  FOR EACH ROW EXECUTE FUNCTION tw_apply_trust_delta();


CREATE TABLE account_restrictions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                restriction_type NOT NULL,
  reason              TEXT NOT NULL,
  issued_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = automated

  starts_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at             TIMESTAMPTZ,               -- NULL = indefinite
  lifted_at           TIMESTAMPTZ,
  lifted_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,

  -- §16 forbids silent shadow-banning. A restriction with notified_at still
  -- NULL past its grace window is an operational alert, not a normal state.
  notified_at         TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT account_restrictions_window_chk CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT account_restrictions_reason_chk CHECK (char_length(btrim(reason)) >= 3)
);

-- One live restriction of a given type per user.
CREATE UNIQUE INDEX account_restrictions_active_uk
  ON account_restrictions (user_id, type) WHERE lifted_at IS NULL;
CREATE INDEX account_restrictions_expiry_idx
  ON account_restrictions (ends_at) WHERE lifted_at IS NULL AND ends_at IS NOT NULL;
CREATE INDEX account_restrictions_unnotified_idx
  ON account_restrictions (created_at) WHERE notified_at IS NULL;


CREATE TABLE user_blocks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_blocks_pair_uk UNIQUE (blocker_user_id, blocked_user_id),
  CONSTRAINT user_blocks_no_self_chk CHECK (blocker_user_id <> blocked_user_id)
);

-- Blocking is symmetric in effect but directional in record, so both
-- directions need an index: candidate generation excludes users I blocked
-- AND users who blocked me.
CREATE INDEX user_blocks_blocker_idx ON user_blocks (blocker_user_id, blocked_user_id);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_user_id, blocker_user_id);


CREATE TABLE reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type         report_target_type NOT NULL,
  target_user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  target_event_id     UUID REFERENCES events(id) ON DELETE CASCADE,
  target_provider_id  UUID REFERENCES providers(id) ON DELETE CASCADE,
  target_review_id    UUID REFERENCES reviews(id) ON DELETE CASCADE,
  target_message_id   UUID REFERENCES messages(id) ON DELETE CASCADE,

  category            TEXT NOT NULL,
  description         TEXT,
  status              report_status NOT NULL DEFAULT 'OPEN',

  handled_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at          TIMESTAMPTZ,
  resolution_note     TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reports_target_chk CHECK (
    (target_type = 'USER'     AND target_user_id     IS NOT NULL AND target_event_id IS NULL AND target_provider_id IS NULL AND target_review_id IS NULL AND target_message_id IS NULL) OR
    (target_type = 'EVENT'    AND target_event_id    IS NOT NULL AND target_user_id  IS NULL AND target_provider_id IS NULL AND target_review_id IS NULL AND target_message_id IS NULL) OR
    (target_type = 'PROVIDER' AND target_provider_id IS NOT NULL AND target_user_id  IS NULL AND target_event_id    IS NULL AND target_review_id IS NULL AND target_message_id IS NULL) OR
    (target_type = 'REVIEW'   AND target_review_id   IS NOT NULL AND target_user_id  IS NULL AND target_event_id    IS NULL AND target_provider_id IS NULL AND target_message_id IS NULL) OR
    (target_type = 'MESSAGE'  AND target_message_id  IS NOT NULL AND target_user_id  IS NULL AND target_event_id    IS NULL AND target_provider_id IS NULL AND target_review_id  IS NULL)
  ),
  CONSTRAINT reports_no_self_chk
    CHECK (target_user_id IS NULL OR target_user_id <> reporter_user_id),
  CONSTRAINT reports_category_chk CHECK (char_length(btrim(category)) BETWEEN 2 AND 60)
);

CREATE INDEX reports_queue_idx ON reports (created_at) WHERE status IN ('OPEN', 'UNDER_REVIEW');
CREATE INDEX reports_reporter_idx ON reports (reporter_user_id, created_at DESC);
CREATE INDEX reports_target_user_idx ON reports (target_user_id) WHERE target_user_id IS NOT NULL;

CREATE TRIGGER reports_set_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION tw_set_updated_at();


-- ============================================================================
-- SAFETY / SOS
--
-- PRIVACY: sos_location_updates is the single table in this schema holding a
-- live device fix. Nothing in Explorer, Matching or Marketplace joins to it.
-- Access is by hashed token only, time-boxed, revocable and logged.
-- ============================================================================

CREATE TABLE sos_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the share token. The plaintext token exists only in the link
  -- handed to the user; a database leak must not yield working share URLs.
  token_hash        BYTEA NOT NULL,

  status            sos_session_status NOT NULL DEFAULT 'ACTIVE',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  last_location_at  TIMESTAMPTZ,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sos_sessions_token_uk UNIQUE (token_hash),
  CONSTRAINT sos_sessions_token_len_chk CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sos_sessions_window_chk CHECK (expires_at > started_at),
  CONSTRAINT sos_sessions_revoked_chk CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

-- At most one live SOS session per user.
CREATE UNIQUE INDEX sos_sessions_active_uk ON sos_sessions (user_id) WHERE status = 'ACTIVE';
CREATE INDEX sos_sessions_expiry_idx ON sos_sessions (expires_at) WHERE status = 'ACTIVE';


CREATE TABLE sos_location_updates (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES sos_sessions(id) ON DELETE CASCADE,
  location     GEOGRAPHY(POINT,4326) NOT NULL,
  accuracy_m   REAL,
  heading_deg  REAL,
  speed_mps    REAL,
  recorded_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sos_location_updates_accuracy_chk CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CONSTRAINT sos_location_updates_heading_chk
    CHECK (heading_deg IS NULL OR heading_deg BETWEEN 0 AND 360),
  CONSTRAINT sos_location_updates_speed_chk CHECK (speed_mps IS NULL OR speed_mps >= 0)
);

CREATE INDEX sos_location_updates_session_idx
  ON sos_location_updates (session_id, recorded_at DESC);
-- Data minimisation: the retention job sweeps by recorded_at.
CREATE INDEX sos_location_updates_retention_idx ON sos_location_updates (recorded_at);

-- Deliberately NO spatial index. Nothing may ever query this table by
-- proximity; the only supported access is "latest fixes for one session".


-- §24 access logging.
CREATE TABLE sos_access_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES sos_sessions(id) ON DELETE CASCADE,
  accessed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ip    INET,
  user_agent   TEXT,
  was_granted  BOOLEAN NOT NULL
);

CREATE INDEX sos_access_log_session_idx ON sos_access_log (session_id, accessed_at DESC);


-- ============================================================================
-- TRANSACTIONAL OUTBOX
--
-- Enqueuing a BullMQ job is a network call to Redis and cannot join a
-- PostgreSQL transaction. Writing the intent here instead means "approve the
-- join request" and "schedule the capture job" commit or roll back together;
-- a relay publishes committed rows to BullMQ.
--
-- DELIVERY MODEL: PostgreSQL outbox -> at-least-once relay -> BullMQ ->
-- idempotent consumer -> consumer acknowledges back HERE.
--
-- The acknowledgement is the point. `published_at` only records that the row
-- was handed to Redis; it is NOT evidence the work happened. If Redis loses
-- its dataset, published-but-unacknowledged rows are still sitting here and
-- are re-published. That is what makes a committed business action
-- reconstructible from PostgreSQL alone after total Redis loss.
--
-- A row is therefore only retired when `completed_at` (consumer succeeded, set
-- in the consumer's own transaction) or `failed_at` (permanently dead, needs a
-- human) is set. Everything else is re-drivable.
-- ============================================================================
CREATE TABLE job_outbox (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic             TEXT NOT NULL,
  payload           JSONB NOT NULL,

  -- Deterministic, caller-derived key (e.g. 'payment.capture:<payment_id>').
  -- Used verbatim as the BullMQ jobId, so a re-publish after uncertain
  -- delivery collapses onto the existing job instead of duplicating work.
  -- UNIQUE means the producing transaction also cannot enqueue the same
  -- logical action twice.
  dedupe_key        TEXT NOT NULL,

  available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Handed to BullMQ. Not proof of execution.
  published_at      TIMESTAMPTZ,
  publish_attempts  INT NOT NULL DEFAULT 0,

  -- Consumer acknowledgement. THIS is proof of execution.
  completed_at      TIMESTAMPTZ,

  -- Permanently dead after max_attempts; surfaced to operators, never silently
  -- dropped.
  failed_at         TIMESTAMPTZ,
  attempts          INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 10,
  last_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT job_outbox_dedupe_uk UNIQUE (dedupe_key),
  CONSTRAINT job_outbox_topic_chk CHECK (char_length(btrim(topic)) BETWEEN 3 AND 100),
  CONSTRAINT job_outbox_attempts_chk
    CHECK (attempts >= 0 AND publish_attempts >= 0 AND max_attempts > 0),
  -- Work cannot be acknowledged before it was dispatched.
  CONSTRAINT job_outbox_ack_requires_publish_chk
    CHECK (completed_at IS NULL OR published_at IS NOT NULL),
  -- A row is not simultaneously successful and dead.
  CONSTRAINT job_outbox_terminal_exclusive_chk
    CHECK (completed_at IS NULL OR failed_at IS NULL)
);

-- The re-drive index. Deliberately covers BOTH never-published rows and
-- published-but-unacknowledged rows, because after a Redis data loss the
-- second category is exactly what must be recovered. The relay selects
-- unacknowledged rows whose lease has lapsed:
--
--   WHERE completed_at IS NULL AND failed_at IS NULL
--     AND available_at <= now()
--     AND (published_at IS NULL OR published_at < now() - lease_interval)
CREATE INDEX job_outbox_undelivered_idx
  ON job_outbox (available_at)
  WHERE completed_at IS NULL AND failed_at IS NULL;

-- Operator queue: jobs that exhausted retries and need a decision.
CREATE INDEX job_outbox_dead_idx ON job_outbox (failed_at) WHERE failed_at IS NOT NULL;


-- ============================================================================
-- Reference data
-- ============================================================================

INSERT INTO event_categories (code, label, icon, sort_order) VALUES
  ('trek',             'Trek',              'mountain',   10),
  ('party',            'Party',             'confetti',   20),
  ('transport',        'Transport',         'bus',        30),
  ('shared_taxi',      'Shared Taxi',       'taxi',       40),
  ('sightseeing',      'Sightseeing',       'camera',     50),
  ('local_experience', 'Local Experience',  'compass',    60),
  ('food_meetup',      'Food Meetup',       'utensils',   70),
  ('beach',            'Beach',             'umbrella',   80),
  ('nightlife',        'Nightlife',         'moon',       90),
  ('other',            'Other',             'dots',      999);

INSERT INTO provider_category_types (code, label, icon, sort_order) VALUES
  ('guide',            'Guide',              'flag',       10),
  ('trekking_company', 'Trekking Company',   'mountain',   20),
  ('taxi',             'Taxi / Transfer',    'taxi',       30),
  ('hostel',           'Hostel Activities',  'bed',        40),
  ('boat_tour',        'Boat Tour',          'anchor',     50),
  ('surf_school',      'Surf School',        'wave',       60),
  ('diving_school',    'Diving School',      'goggles',    70),
  ('nightlife',        'Nightlife Promoter', 'moon',       80),
  ('rental',           'Rental Company',     'key',        90),
  ('other',            'Other',              'dots',      999);
