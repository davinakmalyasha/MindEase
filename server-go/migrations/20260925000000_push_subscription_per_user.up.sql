-- Scope push subscriptions to their owner.
--
-- `PushSubscription.endpoint` was globally unique, and `PushService.subscribe`
-- upserted on the endpoint alone without writing `userId` on the update branch.
-- Two consequences:
--
--   1. A second user presenting the same endpoint — a shared or handed-over
--      device, which is ordinary for a family computer — silently overwrote the
--      first user's key pair. The original owner's push deliveries then failed,
--      and the row's `userId` no longer matched the keys it held. `unsubscribe`
--      was already scoped by `userId`, so the two paths disagreed about
--      ownership.
--   2. There was no way for a row to be reused across users, so the schema
--      encoded a false assumption about how endpoint allocation works.
--
-- The replacement is unique on `(userId, endpoint)`. It also keeps the
-- legitimate case working: browsers rotate the key pair for an unchanged
-- endpoint, and the upsert now updates that row in place.

-- Drop the global unique index. MySQL cannot drop an index that a unique
-- constraint depends on, so the constraint goes first.
ALTER TABLE `PushSubscription` DROP INDEX `PushSubscription_endpoint_key`;

-- Any endpoint already registered by more than one user cannot exist under the
-- old global key, so this cannot lose data. Collapse on the survivor to be safe
-- against a database that predates the global constraint.
DELETE `PushSubscription` FROM `PushSubscription`
INNER JOIN `PushSubscription` `keep`
    ON `keep`.`userId` = `PushSubscription`.`userId`
   AND `keep`.`endpoint` = `PushSubscription`.`endpoint`
   AND `keep`.`id` < `PushSubscription`.`id`;

ALTER TABLE `PushSubscription` ADD UNIQUE INDEX `PushSubscription_userId_endpoint_key` (`userId`, `endpoint`);
