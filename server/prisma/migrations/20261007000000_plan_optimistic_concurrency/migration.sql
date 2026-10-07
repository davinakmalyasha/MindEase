-- Optimistic concurrency on the two patient-owned plan documents.
--
-- `CarePlan` and `SafetyPlan` are single-row-per-owner documents that a patient
-- edits and a clinician may also contribute to. There was no version column, no
-- `updatedAt` precondition, and no last-write-wins detection, so the second save
-- of two concurrent editors silently overwrote the first.
--
-- The design invites this rather than making it an edge case: the plan is
-- patient-owned *and* a clinician can add goals and steps to it. "We both edit
-- this" is the normal case, not the exception.
--
-- `care-plan-regressions.test.ts` already fixed the adjacent failure - a partial
-- save erasing the rest of the document - which was data loss of exactly this
-- kind, from a different cause. This is the concurrent case.
--
-- `version` is bumped by the application inside the same UPDATE that writes the
-- fields, using a conditional `where` on the version the caller was shown. The
-- conditional UPDATE is atomic, so two concurrent saves cannot both win: the
-- loser matches zero rows and gets a 409 rather than a lost document.
--
-- Added as NOT NULL DEFAULT 0 so existing rows are valid at migration time and
-- every subsequent write must state a version explicitly. A nullable column
-- would reintroduce the exact defect this migration exists to remove - a
-- control that applies or not depending on the absence of data - which is the
-- same mistake as the 2FA enrolment guard keyed off a nullable `password`.

ALTER TABLE `CarePlan`
    ADD COLUMN `version` INT NOT NULL DEFAULT 0;

ALTER TABLE `SafetyPlan`
    ADD COLUMN `version` INT NOT NULL DEFAULT 0;
