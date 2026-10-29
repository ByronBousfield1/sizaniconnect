-- 002: one format for cellphone numbers (lecturer feedback on Task 2, back-end security).
--
-- Every stored number is rewritten to E.164 (+27825550134) and the database then refuses anything
-- that is not a South African cellphone number. This is a destructive transformation: numbers that
-- cannot be converted (landlines, toll-free, typing errors) become NULL. So the original value of
-- every row this migration changes is copied to _backup_002_phone_numbers first, and
-- down/002_cellphone_numbers.down.sql restores from it. A later migration drops the backup table
-- once the release has run safely in production for 30 days.

CREATE TABLE _backup_002_phone_numbers (
  table_name      varchar(30) NOT NULL,
  row_id          uuid        NOT NULL,
  original_value  varchar(20) NOT NULL,
  migrated_value  varchar(20),
  backed_up_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, row_id)
);

CREATE OR REPLACE FUNCTION pg_temp.to_sa_cellphone(raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN d ~ '^27(6[0-9]|7[0-9]|8[1-5])[0-9]{7}$' THEN '+' || d
           WHEN d ~ '^0(6[0-9]|7[0-9]|8[1-5])[0-9]{7}$'  THEN '+27' || substr(d, 2)
         END
  FROM (SELECT regexp_replace(raw, '[^0-9]', '', 'g') AS d) AS x
$$;

INSERT INTO _backup_002_phone_numbers (table_name, row_id, original_value, migrated_value)
SELECT 'users', user_id, phone_number, pg_temp.to_sa_cellphone(phone_number)
FROM users
WHERE phone_number IS NOT NULL AND phone_number IS DISTINCT FROM pg_temp.to_sa_cellphone(phone_number);

INSERT INTO _backup_002_phone_numbers (table_name, row_id, original_value, migrated_value)
SELECT 'households', household_id, contact_number, pg_temp.to_sa_cellphone(contact_number)
FROM households
WHERE contact_number IS NOT NULL AND contact_number IS DISTINCT FROM pg_temp.to_sa_cellphone(contact_number);

UPDATE users u SET phone_number = b.migrated_value
FROM _backup_002_phone_numbers b WHERE b.table_name = 'users' AND b.row_id = u.user_id;

UPDATE households h SET contact_number = b.migrated_value
FROM _backup_002_phone_numbers b WHERE b.table_name = 'households' AND b.row_id = h.household_id;

ALTER TABLE users
  ADD CONSTRAINT ck_users_cellphone CHECK (phone_number ~ '^\+27(6[0-9]|7[0-9]|8[1-5])[0-9]{7}$');
ALTER TABLE households
  ADD CONSTRAINT ck_households_cellphone CHECK (contact_number ~ '^\+27(6[0-9]|7[0-9]|8[1-5])[0-9]{7}$');

DROP FUNCTION pg_temp.to_sa_cellphone(text);
