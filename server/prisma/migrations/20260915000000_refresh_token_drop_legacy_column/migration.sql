-- Realign the database with `schema.prisma`.
--
-- The `wave0_auth_hardening` migration replaced refresh-token storage with a
-- SHA-256 digest in `tokenHash`, but never dropped the original `token` column
-- or its unique index. The column is still `NOT NULL` with no default and the
-- unique index is still live, so:
--
--   * on MySQL strict mode every `prisma.refreshToken.create` fails with
--     ERROR 1364 (field 'token' doesn't have a default value), and
--   * on a permissive mode the first two rows collide on the leftover index.
--
-- Either way the row being written is not the row `schema.prisma` describes, and
-- the CI drift gate (`prisma migrate diff --exit-code`) is red because of it.
-- The digest column is the only thing read now, so the plaintext column and its
-- index can go.

DROP INDEX `RefreshToken_token_key` ON `RefreshToken`;
ALTER TABLE `RefreshToken` DROP COLUMN `token`;
