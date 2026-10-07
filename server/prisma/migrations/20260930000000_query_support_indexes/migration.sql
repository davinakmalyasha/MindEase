-- Query-support indexes, found by reading every `where` and `orderBy` in the
-- codebase against the datamodel rather than by guessing.
--
-- These are additive only. Nothing is dropped and no column changes, so this is
-- safe to apply to a live database and safe to roll back by hand.

-- ---------------------------------------------------------------------------
-- 1. Admin appointment listing.
-- ---------------------------------------------------------------------------
--
-- `AppointmentService.listAppointments` runs an unfiltered admin query ordered by
-- `(appointmentDate desc, startTime desc)`. The only `appointmentDate`-leading
-- indexes are `(doctorId, appointmentDate, status)` and `(userId,
-- appointmentDate)`, and both require a leading equality column this query does
-- not supply - so MySQL filesorted the entire Appointment table on every page of
-- the admin's appointment list, plus a full COUNT(*).
CREATE INDEX `Appointment_appointmentDate_startTime_idx`
    ON `Appointment`(`appointmentDate`, `startTime`);

-- ---------------------------------------------------------------------------
-- 2. The reminder and check-in jobs' candidate reads.
-- ---------------------------------------------------------------------------
--
-- Both jobs filter `{ status, reminderSentAt: null, appointmentDate: { range } }`
-- and `{ status, checkinSentAt: null, appointmentDate: { range } }` with no
-- doctor or user column. `(reminderSentAt, appointmentDate, status)` and
-- `(checkinSentAt, appointmentDate, status)` both lead with a nullable column
-- that is `NULL` for every unsent row, so the range on `appointmentDate` cannot
-- be used as a range - MySQL has to scan the NULL block and filter. Leading
-- with `status` puts an equality first and lets `appointmentDate` be a range.
CREATE INDEX `Appointment_status_reminderSentAt_appointmentDate_idx`
    ON `Appointment`(`status`, `reminderSentAt`, `appointmentDate`);
CREATE INDEX `Appointment_status_checkinSentAt_appointmentDate_idx`
    ON `Appointment`(`status`, `checkinSentAt`, `appointmentDate`);

-- ---------------------------------------------------------------------------
-- 3. Care check-in job candidate reads.
-- ---------------------------------------------------------------------------
--
-- Both nudges scan `User` for `role = 'patient'` with a nullable
-- `lastMoodNudgeAt` / `lastDeclineNudgeAt`, ordered by `id`. Without an index
-- that is a full scan of User on a job that runs daily on every replica.
CREATE INDEX `User_role_id_idx` ON `User`(`role`, `id`);

-- ---------------------------------------------------------------------------
-- 4. Admin user listing.
-- ---------------------------------------------------------------------------
--
-- `AdminController.getUsers` sorts by `createdAt desc` with an optional `role`
-- filter and no search. There was no `createdAt` index on User at all, so every
-- page click was a full scan plus filesort.
CREATE INDEX `User_createdAt_idx` ON `User`(`createdAt`);
CREATE INDEX `User_role_createdAt_idx` ON `User`(`role`, `createdAt`);

-- ---------------------------------------------------------------------------
-- 5. Message keyset pagination.
-- ---------------------------------------------------------------------------
--
-- `getMessages` paginates with `orderBy { id: desc }` and an optional `id: { lt:
-- before }` cursor, over a two-sided `OR`. Both existing message indexes end in
-- `createdAt` or in nothing at all, so the keyset filter could not use one and
-- every page of a thread filesorted the whole conversation.
--
-- This was the heaviest client-driven query in the app: the client polls
-- `getMessages` every 5 seconds per open conversation.
CREATE INDEX `Message_senderId_receiverId_id_idx`
    ON `Message`(`senderId`, `receiverId`, `id`);
CREATE INDEX `Message_receiverId_senderId_id_idx`
    ON `Message`(`receiverId`, `senderId`, `id`);

-- ---------------------------------------------------------------------------
-- 6. Conversation list.
-- ---------------------------------------------------------------------------
--
-- `getConversations` runs `OR: [{senderId}, {receiverId}]` ordered by
-- `createdAt desc` with `take: 500`. `(senderId, receiverId, createdAt)` only
-- serves as a prefix because `receiverId` is unconstrained, and
-- `(receiverId, senderId)` has no `createdAt` at all - so every poll gathered
-- all matching rows and then sorted them.
CREATE INDEX `Message_senderId_createdAt_idx` ON `Message`(`senderId`, `createdAt`);

-- ---------------------------------------------------------------------------
-- 7. Notification ordering tiebreaker.
-- ---------------------------------------------------------------------------
--
-- `orderBy: [{ createdAt: desc }, { id: desc }]`. Rows sharing a millisecond
-- needed a filesort for the tiebreaker alone. The client polls this every 15
-- seconds per user.
CREATE INDEX `Notification_userId_createdAt_id_idx`
    ON `Notification`(`userId`, `createdAt`, `id`);
