# Scaling notes

This repository is a portfolio project and is not deployed. What follows is the
scaling model behind the code and the measurement in
[`performance.md`](performance.md): what is already replica-safe, what must be
bought from a provider, and what remains an application decision. It is written
to be useful before a first production deployment, not to pretend one exists.

## What is already replica-safe

The API holds no per-user state in process memory:

- **Sessions** are signed JWTs. Every replica verifies with the same
  `JWT_SECRET`; a token minted by one is accepted by another (measured in
  `performance.md`).
- **Rate limits** live in Redis (`internal/server/ratelimit.go`), so the ceiling
  is shared rather than multiplied by the replica count. If Redis is down the
  limiter falls back to a per-process counter and increments
  `mindease_rate_limit_fallbacks_total`; that is deliberately a degraded mode,
  not a silent one.
- **Scheduled jobs** run in every API process, but the claims are conditional
  `UPDATE`s and the run gate is a Redis lease or a `JobLock` row. A second
  process cannot send the same reminder twice (`internal/server/jobs.go`).
- **Realtime** is a separate Go service; every instance subscribes to the same
  Redis channel, so events reach a socket regardless of which replica accepted
  the API write.
- **Uploads** go to S3 when configured. Without S3 they land on the container
  filesystem; that is why the README and operations guide call S3 a
  multi-replica requirement, not an optimisation.
- **Graceful shutdown, request deadlines, body limits and readiness** exist:
  SIGTERM drains the server, `REQUEST_TIMEOUT` bounds a request,
  `/api/readyz` fails when MySQL is unreachable, and Redis is reported as
  degraded rather than taking every replica out of rotation.

Per-process state that does not prevent scaling but should be known:

- The AI circuit breaker is per process. Five failures open one replica's
  breaker, not the fleet's.
- Metrics are per process; a scraper must hit every replica (or a provider's
  metrics aggregation).
- The in-process connection pool is per process, which is the subject of the
  next section.

## Connection pools

`database/sql` maintains a pool in every API process. The defaults are 20 open,
10 idle, a 30-minute lifetime and a 5-minute idle time, now configurable:

| Variable | Default | Why it matters |
|---|---|---|
| `DB_MAX_OPEN_CONNS` | 20 | Ceiling per process; the fleet total is `replicas × this` |
| `DB_MAX_IDLE_CONNS` | 10 | Kept warm; must not exceed the open ceiling |
| `DB_CONN_MAX_LIFETIME` | 30m | Recycles connections behind load balancers and failovers |
| `DB_CONN_MAX_IDLE_TIME` | 5m | Returns idle capacity to the database |
| `DATABASE_TLS` | off | `true` against a managed database with a verifiable certificate |

The arithmetic is the part that bites during a scale-out:

| API replicas | Connections at 20/replica | Against MySQL's default 151 |
|---:|---:|---|
| 1 | 20 | fine |
| 4 | 80 | fine |
| 8 | 160 | **above the default** |
| 16 | 320 | needs a pooler or a much lower per-replica value |

Before adding replicas, do one of: lower `DB_MAX_OPEN_CONNS`, raise MySQL's
`max_connections` with the memory cost accounted for, or put a pooler in front
(ProxySQL for MySQL; RDS Proxy on Aurora; PlanetScale's HTTP/pooled access).
The pool is a queueing control, not a throughput multiplier — the measured
comparison in `performance.md` shows exactly that.

## Replication

MySQL replication is asynchronous by default. A read replica helps read-heavy
traffic, not write throughput, and it introduces replication lag.

If this were deployed, the safe shape would be:

1. A managed primary with automated failover and point-in-time recovery.
2. One or more replicas for reads that tolerate lag: public doctor directory,
   reviews, statistics, exports.
3. The primary for anything with read-your-writes semantics: immediately after
   booking, payment, a mood write, or a profile change.
4. A separate `DATABASE_READ_URL` and pool, with an explicit router rather than
   a transparent one. Hiding the choice makes lag bugs look random.
5. Both pools in `/api/readyz` and `/metrics`; replica lag metric from the
   provider.
6. A documented stale-read window, and a way for a client to ask for the primary
   (usually a short-lived "just wrote" cookie or query parameter).

This repository does **not** ship that split. Doing it without a real replica
would be untested code plus a claim; the design is recorded here instead. The
first step if it is ever needed is a provider replica and a measured read ratio,
not a refactor.

## Sharding

Sharding is a last resort, not a scale-out button. It decides where a row lives
for the rest of the product's life and makes every cross-user query a fan-out.

None of Vercel, Cloudflare or Supabase shards MySQL for you. Cloudflare fronts
and caches; Vercel hosts the web app; Supabase is Postgres and would be a
database migration before it is a scaling story. Managed sharding exists in
Vitess-based offerings such as PlanetScale. AWS Aurora and Cloud SQL give you
replicas and failover, not horizontal write partitioning.

If MindEase ever crossed that line, the shard key would be the user (patient or
clinician), because nearly every write is scoped to one person. UUIDv7 already
gives globally unique, time-ordered IDs. The hard parts would be the admin
dashboard, doctor search across shards, and anything that joins a patient to a
clinician who lives on another shard; those need a fan-out layer or a derived
read store. There are no distributed transactions here, so each shard would have
to own its invariants end to end.

Do not start here. The thresholds to revisit are write throughput sustained near
the primary's ceiling, a data set that no longer fits a single managed instance,
or a hard regional data-residency requirement.

## Multiple processes

The measured two-process check and the replica-safety list above are the
checklist. In production, add:

- **Sticky sessions are not required** for the API. They are also not required
  for realtime: the hub is on a separate service and Redis fans out events.
- The load balancer must support WebSocket upgrades for the realtime service.
- Every replica must see the same S3 bucket; local uploads are single-instance.
- Scrape `/metrics` from every replica, or aggregate at the platform.
- Drain on deploy: stop accepting, finish in-flight requests, then exit. The
  server already does this on SIGTERM.
- Roll out migrations before the new code (this repository already separates
  `cmd/migrate` from the serving image).

## The rest of the production surface

- **Caching**: Redis is used for the doctor directory and related reads with
  short TTLs. A CDN should cache only public, non-clinical assets; never cache
  an authenticated response containing PHI. Consider singleflight on cache
  misses if a hot key starts stampeding.
- **Queues**: jobs use claims and are in-process today. A durable queue (Redis
  Streams, SQS, Cloudflare Queues) would decouple them from a deploy and make a
  worker tier possible; the claims are already written so a queue is an
  operational improvement, not a correctness one.
- **Observability**: `/metrics` exposes request histograms, in-flight requests,
  Go runtime, the DB pool and job runs. Add tracing at the API/database boundary
  if latency work continues; the existing structured logs already carry request
  IDs.
- **Security**: terminate TLS at the edge, put a WAF in front (Cloudflare or the
  platform's), keep the database private, use the two-identity split in
  [`sql/least-privilege.sql`](sql/least-privilege.sql), require `DATABASE_TLS`,
  and keep `/metrics`/pprof off the public listener. Production refuses to start
  with a metrics address and no token.
- **Backups**: managed MySQL with point-in-time recovery, plus a restore drill.
  The database is the only unreconstructible state; Redis and uploads have
  separate answers.

## Provider map

| Provider | What it actually gives you | What it does not |
|---|---|---|
| Railway | Go containers, MySQL/Redis, volumes, simple vertical scaling | Managed HA, read replicas or sharding (verify the current plan) |
| Vercel | Next.js hosting, CDN, preview deployments, edge network | MySQL; a home for long-lived WebSockets or a pool-heavy Go API |
| Cloudflare | DNS, CDN, WAF/DDoS, R2, Tunnel, load balancing, Workers/Queues | Running this Go binary as-is; MySQL sharding/replication |
| Supabase | Postgres, connection pooling (Supavisor), read replicas, RLS, storage | MySQL; horizontal sharding; a drop-in fit without a DB migration |
| Aurora / Cloud SQL / Azure MySQL | Managed MySQL, replicas, failover, PITR, poolers | Sharding (Vitess/PlanetScale is the managed option) |
| PlanetScale | Vitess-based MySQL, branches, horizontal sharding, read replicas | Free of trade-offs; verify foreign-key and pricing constraints for your tier |

For this repository's size, a single managed MySQL primary plus pooled
connections is the honest ceiling; the measured numbers do not justify anything
larger. Revisit with data, not with a diagram.

## Related

- [ADR-0004](adr/0004-scaling-model.md) — the decision record.
- [`performance.md`](performance.md) — the measurements.
- [`operations.md`](operations.md) — deploy, rollback, backups, secret rotation.
- [`security.md`](security.md) — the threat model and the controls.
