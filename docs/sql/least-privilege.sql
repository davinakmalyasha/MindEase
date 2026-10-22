-- Least-privilege MySQL identities for MindEase.
--
-- Replace the database name, host patterns and passwords before running this
-- anywhere. The point is the split, not the literal values:
--
--   mindease_app      the serving API and the seed. DML only. It cannot alter
--                     the schema, drop a table, or grant anything.
--   mindease_migrate  cmd/migrate only. DDL plus DML, scoped to one schema.
--
-- The API does not need DDL, and a compromised request handler should not be
-- able to run it. The migration binary is the only process that does.
--
-- Run as an administrator on the MySQL primary, once per environment, and put
-- the two URLs in the API's environment:
--
--   DATABASE_URL=mysql://mindease_app:<password>@host:3306/mindease_db
--   (the migration step gets its own URL, never the serving one)

CREATE USER IF NOT EXISTS 'mindease_app'@'%' IDENTIFIED BY '<app-password>';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON `mindease_db`.* TO 'mindease_app'@'%';

CREATE USER IF NOT EXISTS 'mindease_migrate'@'%' IDENTIFIED BY '<migrate-password>';
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `mindease_db`.* TO 'mindease_migrate'@'%';

FLUSH PRIVILEGES;

-- Verify what each identity can do:
--   SHOW GRANTS FOR 'mindease_app'@'%';
--   SHOW GRANTS FOR 'mindease_migrate'@'%';
--
-- The app user deliberately has no GRANT OPTION, FILE, PROCESS, SUPER,
-- CREATE USER, or privileges on any other schema.
