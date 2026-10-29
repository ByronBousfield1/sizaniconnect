-- 003: self-service account recovery that does not depend on email (lecturer feedback on Task 2:
-- "What happens if the admin forgets the password? Can they reset themselves?").
--
-- Each user may hold ten single-use recovery codes. Only a keyed hash of each code is stored, so a
-- copy of the database does not reveal them. Purely additive: earlier releases ignore the table.
CREATE TABLE recovery_codes (
  code_hash   char(64)    PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
CREATE INDEX ix_recovery_codes_user_unused ON recovery_codes (user_id) WHERE used_at IS NULL;
