-- Undoes 004_user_lifecycle_and_retention.sql.
-- Erased accounts and anonymised households stay anonymous: erasure cannot be reversed, by design.
-- An anonymised household gets a placeholder hash (all zeros) so the old NOT NULL rule holds again;
-- it is archived, so the duplicate-registration index ignores it.
DROP INDEX ix_users_awaiting_erasure;
DROP INDEX ix_households_retention;

UPDATE households SET id_number_hash = repeat('0', 64) WHERE id_number_hash IS NULL;
ALTER TABLE households
  DROP CONSTRAINT ck_households_anonymised_is_archived,
  DROP CONSTRAINT ck_households_id_hash_unless_anonymised,
  ALTER COLUMN id_number_hash SET NOT NULL,
  DROP COLUMN anonymised_at,
  DROP COLUMN archived_at;

ALTER TABLE users
  DROP CONSTRAINT ck_users_inactive_has_date,
  DROP CONSTRAINT ck_users_erased_is_inactive,
  DROP COLUMN erased_at,
  DROP COLUMN deactivation_reason,
  DROP COLUMN deactivated_at;
