-- Undoes 003_account_recovery.sql. Users lose their recovery codes; email reset still works.
DROP TABLE recovery_codes;
