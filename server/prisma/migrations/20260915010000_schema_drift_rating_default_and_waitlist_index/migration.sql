-- Close the remaining gap between the database and `schema.prisma`.
--
-- Both changes below were visible only to `prisma migrate diff --exit-code`, the
-- CI schema-drift gate. They are the reason that gate is worth keeping.
--
-- 1. `doctor.rating` still had the baseline's `DEFAULT 5.0`, because the
--    wave0 migration backfilled the value but never altered the column default.
--    The datamodel has always said `@default(0)`, and the comment above
--    `Doctor.rating` explains why: a clinician with no reviews must not be shown
--    to patients as a perfect 5.0, which is a false clinical claim. In practice
--    every insert goes through Prisma, which sent the default explicitly, so the
--    bad SQL default stayed latent — but any insert that omitted the column
--    would have produced a 5.0-rated doctor with zero reviews.
ALTER TABLE `doctor` MODIFY `rating` DOUBLE NOT NULL DEFAULT 0;

-- 2. The corrected waitlist unique key `(doctorId, patientId)` was created in
--    the datamodel but the original three-column key
--    `(doctorId, patientId, status)` was never dropped, so both were live. The
--    two-column key is the one the code relies on; the three-column one is pure
--    write amplification on a table written on every join and leave.
--
--    Note `WaitlistEntry_doctorId_fkey` is deliberately left in place. Prisma's
--    diff proposes dropping it, which would remove real referential integrity.
DROP INDEX `WaitlistEntry_doctorId_patientId_status_key` ON `waitlistentry`;
