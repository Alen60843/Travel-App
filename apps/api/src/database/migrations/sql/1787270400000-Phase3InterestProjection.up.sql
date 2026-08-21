-- Preserve user_interests as historical/editorial selections, but expose only
-- currently active interests in the denormalised matching projection.
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
              JOIN interests i ON i.id = ui.interest_id
             WHERE ui.user_id = target_user
               AND i.is_active),
           '{}'::INT[]
         )
   WHERE p.user_id = target_user;
  RETURN NULL;
END $$;

-- Editorial activation changes must update every affected projection without
-- deleting the user's historical selection row.
CREATE OR REPLACE FUNCTION tw_sync_interest_activity() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE user_profiles p
     SET interest_ids = COALESCE(
           (SELECT array_agg(ui.interest_id ORDER BY ui.interest_id)
              FROM user_interests ui
              JOIN interests i ON i.id = ui.interest_id
             WHERE ui.user_id = p.user_id
               AND i.is_active),
           '{}'::INT[]
         )
   WHERE EXISTS (
     SELECT 1
       FROM user_interests selected
      WHERE selected.user_id = p.user_id
        AND selected.interest_id = NEW.id
   );
  RETURN NULL;
END $$;

CREATE TRIGGER interests_sync_active_projections
  AFTER UPDATE OF is_active ON interests
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE FUNCTION tw_sync_interest_activity();

-- Reconcile projections created before this rule existed.
UPDATE user_profiles p
   SET interest_ids = COALESCE(
         (SELECT array_agg(ui.interest_id ORDER BY ui.interest_id)
            FROM user_interests ui
            JOIN interests i ON i.id = ui.interest_id
           WHERE ui.user_id = p.user_id
             AND i.is_active),
         '{}'::INT[]
       );
