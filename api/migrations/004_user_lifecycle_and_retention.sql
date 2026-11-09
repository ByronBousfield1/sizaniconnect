-- 004: removing people's personal data when they leave (lecturer feedback on Task 2, database:
-- "What happens if the user retires? How are they removed from the database completely?") and
-- NFR-16 (archived households anonymised after 24 months).
--
-- Users:      Active -> Offboarded (deactivated_at, reason) -> Erased (erased_at).
-- Households: Archived (archived_at) -> anonymised (anonymised_at), personal fields cleared.
-- Additive apart from relaxing NOT NULL on households.id_number_hash, which an anonymised
-- household no longer has.

ALTER TABLE users
  ADD COLUMN deactivated_at      timestamptz,
  ADD COLUMN deactivation_reason varchar(20)
    CONSTRAINT ck_users_deactivation_reason CHECK (deactivation_reason IN ('Retired','Resigned','RoleEnded','Other')),
  ADD COLUMN erased_at           timestamptz;

-- Accounts already deactivated before this release: the date is unknown, so the migration date stands in.
-- This must run before the constraints below are added, or a database that already has a deactivated
-- account (production does) fails the check and the release cannot start.
UPDATE users SET deactivated_at = now(), deactivation_reason = 'Other' WHERE NOT is_active;

ALTER TABLE users
  ADD CONSTRAINT ck_users_erased_is_inactive CHECK (erased_at IS NULL OR NOT is_active),
  ADD CONSTRAINT ck_users_inactive_has_date CHECK (is_active OR deactivated_at IS NOT NULL);

ALTER TABLE households
  ADD COLUMN archived_at   timestamptz,
  ADD COLUMN anonymised_at timestamptz,
  ALTER COLUMN id_number_hash DROP NOT NULL,
  ADD CONSTRAINT ck_households_id_hash_unless_anonymised CHECK (id_number_hash IS NOT NULL OR anonymised_at IS NOT NULL),
  ADD CONSTRAINT ck_households_anonymised_is_archived CHECK (anonymised_at IS NULL OR status = 'Archived');

UPDATE households SET archived_at = updated_at WHERE status = 'Archived';

CREATE INDEX ix_households_retention ON households (archived_at) WHERE status = 'Archived' AND anonymised_at IS NULL;
CREATE INDEX ix_users_awaiting_erasure ON users (deactivated_at) WHERE NOT is_active AND erased_at IS NULL;
