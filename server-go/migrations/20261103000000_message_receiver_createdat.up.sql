-- Conversation list receiver leg.
--
-- GET /messages/conversations merges the two directions of a user's mail:
-- sent (senderId = ?) and received (receiverId = ?). The sent leg is
-- covered by Message_senderId_createdAt_idx, but the received leg had no
-- (receiverId, createdAt) prefix and fell back to a full scan with a
-- filesort on every 30s poll. This index gives each leg a bounded
-- covering lookup; the Go merge keeps exact paging semantics.
CREATE INDEX `Message_receiverId_createdAt_idx`
    ON `Message`(`receiverId`, `createdAt`);
