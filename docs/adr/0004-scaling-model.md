# ADR-0004: One pooled MySQL primary now; replicas before shards

- Status: accepted
- Date: 2026-10

## Context

MindEase is a portfolio project: it is public, tested and documented, but it is
not deployed. The scaling questions still matter because the code should not be
naive about them, and because "we would shard it" is not an answer without a
reason.

The measured runs in [`../performance.md`](../performance.md) put the local API
at roughly 1,000 requests/second on a four-core laptop, with the API, MySQL,
Redis and the load generator sharing the machine. At 150 VUs, a 20-connection
pool cut p99 from 212 ms to 152 ms and cut cumulative connection waiting from
about 600 seconds to 4, without changing throughput. At 50 VUs, five connections
were enough. The API passed a two-process test with shared sessions and state.

That is the profile of a small product whose first constraint is operational
(backups, failover, connection math), not a sharding problem.

## Decision

1. **Keep one MySQL primary and do not implement sharding.** The schema, the
   foreign keys, the admin queries and the clinical relationships all assume one
   database. A shard key would be the user, but doctor search, admin reporting
   and cross-user relationships would become fan-outs, and there are no
   distributed transactions to make that safe.
2. **Make the pool explicit and measurable.** `DB_MAX_OPEN_CONNS` and friends
   are configuration, the pool is exposed as Prometheus gauges/counters, and the
   fleet total (`replicas × MaxOpen`) is documented against MySQL's
   `max_connections`. A pooler (ProxySQL, RDS Proxy, PlanetScale) is an
   operational addition when the replica count or the connection ceiling says
   so; it is not needed at the measured scale.
3. **Read replicas are a later, explicit step.** If read pressure is measured,
   add `DATABASE_READ_URL` plus a read pool and route only reads that tolerate
   lag. Anything with read-your-writes semantics stays on the primary. No
   transparent router: making lag invisible makes the resulting bugs look
   random.
4. **Keep the API stateless and prove it.** Sessions are JWTs, rate limits are
   in Redis, jobs claim rows, realtime fans out through Redis, and uploads go to
   S3. `/api/readyz`, request timeouts and graceful shutdown are part of the
   replica contract. `/metrics` and pprof live on a private listener with a
   token required in production.
5. **Do not migrate the database or the API runtime for scale theatre.** Supabase
   is Postgres, so it means a schema/SQL/test migration; Vercel is the web host,
   not a home for this long-lived WebSocket and pooled-connection API; Cloudflare
   is the edge, CDN, WAF and R2, not a MySQL scaling layer.

## Consequences

- The deployment story stays small: one managed primary, one API service with
  N replicas, one realtime service, Redis, S3.
- The first scaling action is a measured one: lower the pool, add a pooler, or
  add a replica. The README and `/metrics` say which numbers to watch.
- Multi-region, sharding and read replicas remain documented but unbuilt. That
  is deliberate: untested code for a topology nobody runs is worse than an
  honest boundary.
- The `perf/` scripts are part of the repository so the next change can be
  measured rather than argued about.

## Alternatives rejected

- **Shard now.** No measured write ceiling, and the cross-user queries would
  pay for it immediately.
- **Transparent read/write split.** Hides replication lag behind a router; the
  failure mode is a patient not seeing a booking they just made.
- **Move to Supabase/Postgres.** A database migration for this codebase is a
  rewrite of every query, migration and integration test, with no product
  benefit at this scale.
- **Run the API as serverless functions.** The WebSocket service, shared pools
  and Redis fan-out are the opposite of that execution model.
