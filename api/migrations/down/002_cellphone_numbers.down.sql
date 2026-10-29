-- Undoes 002_cellphone_numbers.sql.
-- Drops the format rules, then puts back the original value of every row 002 changed, but only
-- where the number has not been edited since (an edited number is newer information and is kept).
ALTER TABLE users DROP CONSTRAINT ck_users_cellphone;
ALTER TABLE households DROP CONSTRAINT ck_households_cellphone;

UPDATE users u SET phone_number = b.original_value
FROM _backup_002_phone_numbers b
WHERE b.table_name = 'users' AND b.row_id = u.user_id
  AND u.phone_number IS NOT DISTINCT FROM b.migrated_value;

UPDATE households h SET contact_number = b.original_value
FROM _backup_002_phone_numbers b
WHERE b.table_name = 'households' AND b.row_id = h.household_id
  AND h.contact_number IS NOT DISTINCT FROM b.migrated_value;

DROP TABLE _backup_002_phone_numbers;
