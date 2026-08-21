DROP TRIGGER IF EXISTS interests_sync_active_projections ON interests;
DROP FUNCTION IF EXISTS tw_sync_interest_activity();

-- Restore the pre-correction projection rule: every historical selection is
-- projected regardless of editorial activity.
CREATE OR REPLACE FUNCTION tw_sync_interest_ids() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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

UPDATE user_profiles p
   SET interest_ids = COALESCE(
         (SELECT array_agg(ui.interest_id ORDER BY ui.interest_id)
            FROM user_interests ui
           WHERE ui.user_id = p.user_id),
         '{}'::INT[]
       );
