# Operations

Local setup, the three-environment picture, backups, secret rotation, rollback,
and the jobs that are not durable. Everything here is derived from what the
repository actually does; where a step is manual it says so.

Related: [`testing.md`](testing.md) for the gates you must pass before any of
this, [`security.md`](security.md) for what the deployment is defending.

## Local setup

### Everything at once (Docker)

Five services: `mysql`, `redis`, `api`, `realtime`, `web`.

```bash
cp .env.example .env       # fill in at minimum JWT_SECRET, REFRESH_SECRET, TWO_FACTOR_SECRET
docker compose up --build
```

`JWT_SECRET` and `REFRESH_SECRET` have **no defaults** in the compose file, so the
stack will not start without them. `TWO_FACTOR_SECRET` does have a local default
(`local_dev_two_factor_secret_change_me`) — it is there because its absence once
made `docker compose up` crash-loop the API.

`docker compose up --wait` waits for all five health checks. Every service
declares one, which matters more than it looks: without the `web` healthcheck,
compose reports the stack ready while Next.js is still compiling or has already
crashed.

Two compose decisions worth knowing before you debug:

- **The local stack runs the payment simulator**, with
  `ALLOW_PAYMENT_SIMULATOR=true` set explicitly, even though
  `NODE_ENV: production`. `env.ts` refuses the simulator in production *unless*
  that opt-in is present, so this is a deliberate local-only choice and not an
  accident.
- **`NEXT_PUBLIC_*` values are build args, not environment variables.** They are
  inlined into the browser bundle at build time. Declaring them under
  `environment:` only sets them inside the container, where the already-built
  bundle cannot see them, so the shipped app silently used the hard-coded
  localhost fallbacks.

`DATABASE_URL`, `REDIS_URL` and `TZ` are supplied by the file; you do not set
them.

### Three processes, run separately

```bash
# 1. API — :5000
cd server-go
go mod download
DATABASE_URL=mysql://... go run ./cmd/migrate
DATABASE_URL=mysql://... go run ./cmd/seed
bash scripts/dev.sh      # loads the root .env

# 2. Realtime (Go) — ws://localhost:8080/ws
cd server-realtime
go mod download
go run .

# 3. Web — :3000
cd client
npm install
npm run dev
```

Prerequisites: Node 22+, MySQL 8, Redis, Go 1.26.

### Seeded accounts

| Role | Email | Password |
|---|---|---|
| Patient | `patient@mindease.app` | `Patient@123` |
| Doctor ×8 | `dr1@mindease.app` … `dr8@mindease.app` | `Doctor@123` |
| Admin | `admin@mindease.app` | `Admin@123` |

The seed is idempotent for the accounts and skips doctors that already exist. It
creates **zero reviews** and leaves `Doctor.rating` / `totalReviews` at their
defaults on purpose — it used to invent a 4.2–4.9 rating for every clinician with
no reviews, which is the fabricated-rating policy the `Doctor.rating` column
comment exists to prevent, and it made the "Top Rated" sort rank the
most-liked-looking profiles first. Demo data should not model the bug. If you
need a review, complete a consultation as the patient and write one.

## The three environments

| | Local compose | A reviewer's Railway/Vercel account | Production |
|---|---|---|---|
| MySQL | `mysql:8.4` service, volume `mysql_data` | Managed MySQL | Railway MySQL, managed backups |
| Redis | `redis:7-alpine`, **no volume** | Managed Redis | Managed Redis |
| API | `:5000`, `NODE_ENV=production` | `:5000` | Railway service |
| Realtime | `:8080` | `:8080` | Railway service |
| Web | `:3000` | Vercel | Vercel |
| Payments | `simulator`, opted in | `simulator` | `midtrans` (stubbed — see below) |
| Video | `jitsi` unless configured | `jitsi` unless configured | `livekit` |

The thing to internalise: **`docker-compose.yml` runs the API with
`NODE_ENV: production`.** That is what the image is built for, so local runs
through the same secret validation, the same payment-simulator refusal and the
same "S3 not configured" warning as production. It is not a relaxed mode.

The three secrets are validated at boot by `config/env.ts`, which **throws** in
production rather than warning:

- missing → throw
- a known-weak default from a hardcoded list → throw
- anything starting with `dev_` → throw
- shorter than 16 characters → throw
- `REFRESH_SECRET === JWT_SECRET` → throw
- `TWO_FACTOR_SECRET === JWT_SECRET` → throw
- the payment simulator in production without `ALLOW_PAYMENT_SIMULATOR=true` →
  throw
- an unrecognised `PAYMENT_PROVIDER` → throw

A config error is therefore a **crash loop with a one-line reason in the logs**,
not a degraded boot. That is the intended behaviour and the first thing to check
when a deployment will not come up.

### Production checklist

- [ ] Real SMTP. `mailer.service.ts` **throws** without it in production — email flows fail loudly by design.
- [ ] Redis reachable. Costs realtime push *and* the shared rate-limit counters; without it every limit is per-process.
- [ ] S3-compatible storage. Railway's filesystem is ephemeral; see below.
- [ ] Three strong, distinct secrets.
- [ ] `JWT_SECRET` byte-identical across API, realtime **and** the web app's edge proxy.
- [ ] Google OAuth client on the production domain.
- [ ] `VIDEO_PROVIDER=livekit` with all three `LIVEKIT_*` set.
- [ ] Backups configured — see below.
- [ ] Railway MySQL managed backups, **or** a scheduled `backup.ps1`.

**Why S3 is called out separately from the other optional services.** Missing S3
is not a degraded feature, it is data loss waiting to happen. `lib/storage.ts`
falls back to the container's local disk, and `Dockerfile` creates
`public/uploads` with no `VOLUME`, so on more than one replica an avatar
uploaded to instance A 404s on instance B and everything is lost on the next
deploy. `deleteFile` then silently no-ops, so the directory grows without bound.
`env.ts` warns rather than throws here for one reason: `docker-compose.yml` sets
`NODE_ENV: production` with no S3, and that is the documented way to run the
project locally.

## Deploys

`.github/workflows/cd.yml` runs on merge to `main`, and on `workflow_dispatch`
with an optional `skip_web` input.

```
preflight ──┬── deploy_api (Railway, env: production) ──┐
            │     └─ railway up api ── wait /api/health ── railway up realtime ── wait /health
            └── deploy_web (Vercel, env: production) ────┤
                                                          └── verify (env: production)
```

**Preflight** fails fast if `RAILWAY_TOKEN`, `VERCEL_TOKEN`,
`RAILWAY_API_SERVICE` or `RAILWAY_REALTIME_SERVICE` is missing. A
half-configured deploy that fails at the last step is the expensive kind.

**`concurrency: group: production-deploy, cancel-in-progress: false`.** Two
concurrent production deploys race on `prisma migrate deploy`, and a
partially-applied migration is worse than a queued one.

**The API is deployed before the realtime service**, because the realtime
service is useless until the database has the tables it expects.

**Migrations are a separate step, deliberately.** The API image does not touch
the schema at boot: `docker compose` runs a one-shot `migrate` service and the
API waits for it, and production applies the same command (`go run ./cmd/migrate`,
or the `migrate` binary in the image) before the deploy. The runner records
versions in `schema_migrations` and baselines a database built by the old Prisma
runner, so an upgrade does not replay history. Ad-hoc DDL (`db push`) is never
used against production: it leaves the database silently diverged from the
committed migrations.

**`deploy_web` builds before deploying** (`npm run build`, then
`vercel build --prod`, then `vercel deploy --prebuilt`). A build that fails
should fail where nothing has been touched, rather than inside the Vercel build
where the failure is a red badge and the previous deployment is already gone.

**`verify` runs `if: always()`** after a successful API deploy, whether or not
the web deploy ran, and prints all four health checks into the job summary. It
exists because reporting a deploy's own output as proof of success is not a
read-back.

### The one manual step

**The GitHub `production` environment must exist, with required reviewers.**

Until it does, GitHub allows the deploy job with no prompt. The workflow can be
dispatched and will run against production whether or not anyone approved it. The
`cd.yml` header says this is the one piece of setup that matters. Create it in
repo settings → Environments → `production` → Required reviewers.

This is a real gap rather than a formality. `AGENTS.md` forbids mutating
production without explicit approval; the environment gate is the mechanism that
enforces it, and it is opt-in on GitHub's side.

**Everything else is first-time manual setup, and the workflow assumes it exists:**
the Railway projects and services, the Vercel project, and the secrets listed
above. `cd.yml` does not create any of them.

## Backups and restore

### What to back up

The database is the only state that cannot be reconstructed. A consistent dump
is the whole recipe:

```bash
mysqldump -u root -p --single-transaction --routines mindease_db > mindease_db.sql
```

Avatars live in S3 or the container volume; Redis holds only cache and pub/sub,
both reconstructible. Nothing in this repository schedules, verifies or ships
the dump, and the `.sql` file is plaintext containing every risk alert, mood
note and journal entry — put it somewhere encrypted, on a different disk, and
never commit it. (`.gitignore` refuses `*.sql` outside the migrations and
`backups/`.)

### Restore

There is **no restore script**. It is a `mysql` invocation:

```powershell
Get-Content D:\backups\mindease_db_20260930_040000.sql -Raw |
  mysql -u root -p mindease_db
```

Verify the restore by row counts on the tables that matter, not by exit code:

```sql
SELECT COUNT(*) FROM User;
SELECT COUNT(*) FROM RiskAlert WHERE resolvedAt IS NULL;   -- the open disclosures
SELECT COUNT(*) FROM Appointment;
```

The reason the open-disclosure count is in that list: those rows are the one
thing in this database that is deliberately retained through account deletion,
and they are the first thing a restore should be checked against.

### The preferred option

**Railway's managed MySQL plugin**, which does scheduled backups, retention and
point-in-time restore without any of the above. Use `backup.ps1` as the escape
hatch for a self-managed database, and if you use it, put the output somewhere
encrypted and somewhere that is not the same disk.

## Secret rotation

| Secret | Where it lives | Blast radius of changing it |
|---|---|---|
| `JWT_SECRET` | API, realtime, **and** the web app's edge proxy | **Every session in the system ends**, immediately, in all three processes at once. Also invalidates outstanding ws-tickets. |
| `REFRESH_SECRET` | API only | Every 7-day session ends. Users re-authenticate; no data is affected. |
| `TWO_FACTOR_SECRET` | API only | Pending 2FA tickets stop verifying; a user mid-challenge restarts it. |
| `PAYMENT_SERVER_KEY` | API only | Provider callbacks fail signature verification and stop granting entitlements. |
| `LIVEKIT_API_SECRET` | API only | Existing video tokens stop verifying. No effect on anything else. |
| `LIVEKIT_API_KEY`, `S3_*`, `VAPID_*`, `SMTP_PASS`, `WA_GATEWAY_TOKEN` | Their service | Service-local. |

**Rotating `JWT_SECRET` safely.** It must be byte-identical in three places at
once, so the sequence matters:

1. Update the **realtime** service and the **web** proxy first. Neither mints
   tokens; they only verify. A mismatch there fails *closed* on verification
   rather than open.
2. Update the **API** last. This is the step that ends sessions.
3. Restart all three. The realtime service fail-fast boots on an unparseable
   `REDIS_URL`, so confirm it came back rather than assuming.
4. Check `/api/health`, then `/health` on the realtime service.

For `REFRESH_SECRET` the same three-step order applies for the same reason,
though the realtime service and the proxy do not hold it — only the API changes,
and users simply log in again.

There is no key-versioning or dual-key acceptance window. Rotation is a hard cut.

## Rollback

**Rolling back the API is safe if the previous release's migrations are a prefix
of the current ones.** Because `migrate deploy` runs on boot and there is no
down-migration, a rollback to an older image against a newer schema is only as
safe as that image tolerates extra columns. Additive migrations are; a migration
that drops or renames something is not.

If the API is failing, the usual sequence:

1. `GET /api/health` and `GET /api/health/db` — is it the process or the
   database?
2. Railway service logs — a config validation failure names the variable and
   throws at boot.
3. Roll back the deployment. Railway keeps previous deployments.
4. Confirm with a read-back of `/api/health/db`, not the deploy output.

**Rolling back a migration is not a supported operation here.** There is no
down-migration in any of the 15 migration folders and `migrate deploy` does not
reverse. If a migration applied cleanly and is wrong, the recovery is a forward
migration, not a rollback.

**Rolling back the web app** is `vercel deploy --prebuilt` from an older commit,
or the Vercel dashboard's promote-to-production on a previous deployment.

## The cron jobs, and what is durable about them

**All three scheduled jobs run inside the API process, via `node-cron`.** There
is no queue and no worker process. What there is: each job's work is defined by
rows and sentinels rather than by the tick that notices them, so a lost tick
costs a delay, not the work.

| Job | Schedule | Timezone | File |
|---|---|---|---|
| Appointment reminders | `*/10 * * * *` | `Asia/Jakarta` | `src/jobs/reminders.ts` |
| Weekly report check | `0 7 * * *` | `Asia/Jakarta` | `src/jobs/reminders.ts` |
| Care check-ins + waitlist maintenance | `0 9 * * *` | `Asia/Jakarta` | `src/jobs/checkins.ts` |

All three are gated on `NODE_ENV !== "test"`, and all three run **on every
replica**.

**A missed tick is caught up by the next one.** Every job's eligibility is a
window or a sentinel, not "is it exactly this minute":

- reminders: `reminderSentAt IS NULL` and the session still 0–24h ahead, so a
  restart at 09:55 reminds for everything the 09:50 tick would have
- check-ins: `User.lastMoodNudgeAt` / `lastDeclineNudgeAt` and
  `Appointment.checkinSentAt` null-or-older-than-the-period
- the weekly report: `User.lastWeeklyReportAt` older than this week's Monday, so
  a Monday lost to a deploy goes out on the next daily check instead of waiting
  a week. The run is daily and the **claim** is what makes it weekly.

The residual gap is a process that is down for the *entire* window: a session
that starts during the outage is never reminded, because once it has started
there is nothing left to catch up to. That direction is deliberate — a missed
reminder is embarrassing, a missed **risk escalation** would not be, and
escalations do not run here at all: `raiseRiskAlert` is synchronous inside the
request that observes the risk.

**Every replica scans, and only the claim prevents a duplicate send.** Correctness
comes from a conditional `updateMany`, not from the schedule:

- reminders claim on `Appointment.reminderSentAt IS NULL`
- check-ins claim on `User.lastMoodNudgeAt` / `lastDeclineNudgeAt` and
  `Appointment.checkinSentAt IS NULL`
- the weekly report claims on `User.lastWeeklyReportAt`

Those columns are indexes in their own right, added precisely because each claim
was a full table scan on every replica.

**A failed send hands its claim back.** The claim is taken *before* the send, so
something has to undo it when the send fails — otherwise the sentinel stays set
and the patient is never nudged again until the next period (three days for the
mood nudge, never for a post-session check-in). Reminders release when every
delivery failed; the check-in nudges and the weekly report release on any
failure. The tests for that behaviour fail against the code that swallowed the
error, which is how it is held in place.

**The claim is taken after the eligibility check, and that ordering is
load-bearing.** It used to be the other way round, so a session whose calendar
*date* fell inside the 24-hour horizon but whose *start time* did not — a
late-evening session the next morning — burned `reminderSentAt` and was then
skipped on every future run. The patient was never reminded and nothing reported
the loss. `reminders.ts` says so at length where the check lives.

**The locks are a scan optimisation and they no longer depend on Redis.**
`runCareCheckins` takes an `acquireLock("care-checkins", 3600)` before reading
anything, which saves roughly 120k queries per run at 10k patients. `cache.ts`
falls back to a `JobLock` row when Redis cannot be reached, so the single-runner
property survives a Redis outage; the claims remain the correctness mechanism
either way.

**Every run logs what it sent** (`{ moodNudges, declineNudges, sessionCheckins }`
and `{ sent, failed }`). A broken job's signature is a silent zero, and one line
per run is the cheapest way to make that visible.

**What remains is deployment, not code.** These jobs still stop when the
process does. `src/worker.ts` is the process that stays up when the API is
redeployed: `npm run worker` runs the same registry on the same schedules, and
the API forwards its cron ticks to it when `JOBS_WEBHOOK_URL` is set
(`JOBS_SECRET` on both sides authenticates the trigger; without it the endpoint
does not exist). Both can run at once without duplicating sends - the claims are
the guarantee - so the switch is safe in either order.

To deploy it: a second service from the same image with command
`npm run worker`, the same database/Redis/mailer environment as the API, and on
the API `JOBS_WEBHOOK_URL=<worker URL>` plus `JOBS_SECRET=<random>`. Without
those variables the API keeps running the jobs in-process, which is the
single-service default and what local development uses. Nothing
safety-relevant runs on this schedule, which is what keeps that a Tier 2 item.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| API crash-loops at boot with `[config] Missing required environment variable: X` | A required secret is absent | Railway service variables; the message names the variable |
| API crash-loops with `must differ from JWT_SECRET` | Two secrets are the same value | `env.ts` refuses this by design; a shared secret means a 2FA ticket verifies as an access token |
| API crash-loops with `still uses its development fallback` | A secret starts with `dev_` | Usually a copied `.env.example` |
| API crash-loops with `simulator in production` | `PAYMENT_PROVIDER` unset or `simulator` with no opt-in | Set real credentials, or `ALLOW_PAYMENT_SIMULATOR=true` for a demo deployment only |
| `/api/health` 200 but `/api/health/db` 503 | The process is up, MySQL is not | `DATABASE_URL`; the service container; `mysqladmin ping` |
| Every browser in a reconnect loop, realtime `/health` is 503 | Redis unreachable from the Go service | `REDIS_URL`. go-redis reports a bad URL only through a no-op logger, so a misconfiguration looks like an outage |
| Realtime stays up, reports healthy, but no events arrive | `REDIS_URL` parsed into a dial string wrong | Boot now fails loudly on an unparseable URL; if it booted, suspect a channel-name or auth mismatch |
| Realtime refuses to start with a URL error | A bare `host:port` was passed where a URL was expected, or the reverse | `redisOptions` accepts both forms and rejects other schemes |
| Rate limits behave as though there is one user | Redis is down, so every limiter fell back to per-process memory | `lib/cache.ts` logs `Redis cache unavailable - cache disabled` |
| Realtime `/health/db` fine but client sees stale badges | Cache TTL, or a dropped event for a slow consumer | Events are dropped, not queued; refresh the page |
| `npm test` fails in `beforeEach` at the wipe | `TEST_DATABASE_URL` cannot authenticate | `mysql://root:@127.0.0.1:3306/mindease_test` assumes passwordless root; CI sets both it and `DATABASE_URL` to the same value |
| `npm test` fails with `Prisma.dmmf.datamodel.models is empty` | The Prisma client was not generated | `npx prisma generate` — and note the wipe is now a no-op-with-a-crash rather than silently doing nothing |
| `npm test` fails on every unique constraint | The test database was built with `db push` against a schema that no longer matches | `npm run test:db` again, or `migrate deploy` + the drift gate |
| Two security tests fail on a timeout only | The 120 s timeout was reduced | It is 120 000 for both `testTimeout` and `hookTimeout` for this reason |
| A 2FA test fails with `TOTP_REQUIRED` unexpectedly | The TOTP step advanced mid-test | `pinTwoFactorClock()` / `unpinTwoFactorClock()` |
| `go test` fails with `compile: version "goX" does not match go tool version "goY"` | Stale build cache | `go clean -cache` |
| `go test -race` reports a data race in `hub` | A real concurrency bug in the hub | Do not suppress it; that suite exists for this |
| Compose reports ready but the web app 404s | The `web` healthcheck is missing, or Next.js has not compiled | Every service declares a healthcheck; `start_period: 20s` on `web` |
| The deployed web app talks to `localhost:5000` | `NEXT_PUBLIC_*` set as environment instead of build args | They are inlined at build time |
| Avatars 404 on some requests | S3 unset; uploads are on a local disk and the instance moved | Set the four `S3_*` variables before scaling past one replica |
| Avatars fine until the next deploy, then all gone | Same cause — no `VOLUME` on `public/uploads` | Same |
| Emails "sent" but nothing arrives | SMTP unset; in non-production they are printed to the console | In production the boot **throws** instead, so this means you are not in production |
| Consent OTP silently cancels a password reset | Old build; the two flows used to share one OTP slot | `resetOtp*` and `verifyOtp*` are now separate columns |
| `node scripts/check-dependencies.js` reports an unused package | Either it really is unused, or it is referenced in a way the scanner does not match (a config value, a peer dependency) | Remove it, or reference it, or add a reason to `INDIRECT` in the script; the self-test holds each case |
| A dev browser keeps running an old bundle after an edit | A service worker registered by an earlier dev session is serving its cached chunks | The worker is no longer registered outside production and existing ones are removed on load; a profile loaded before that change needs one manual unregister |
| Risk alert exists but is not in the clinician's queue | The assignment lapsed with the appointment | `assignedDoctorUserId` keeps it visible; unassigned alerts need a live relationship |
| Nothing arrived for a risk alert | A realtime event was dropped for a slow consumer, or all channels failed | The row is still there and the queue is polled as well as pushed |

## Health endpoints

| Endpoint | Checks | Meaning |
|---|---|---|
| `GET /api/health` | uptime, timestamp | The process is up. Cheap; no dependency probe. |
| `GET /api/health/db` | every model in the generated client exists as a table | MySQL is reachable **and** the schema matches this build. **This is the one that matters.** |
| `GET /health` (realtime) | a 2-second Redis `Ping` | 503 when Redis is unreachable. It used to answer `ok` unconditionally, which made a total realtime outage look healthy to compose, Railway and any uptime monitor while every browser sat in a reconnect loop. |

`/api/health/db` used to run `SELECT 1`, which proves MySQL answers and says
nothing about whether the migrations ran. The failure it could not see is the one
that actually happens on a deploy: the migration step is skipped, the API boots,
the probe goes green, and the first request touching a new column returns a 500 —
found by a user rather than by the endpoint that exists to be asked.

It compares `INFORMATION_SCHEMA.TABLES` against `Prisma.dmmf`, so it is checking
what *this build* expects rather than a second hand-maintained list, and the
comparison is case-insensitive because MySQL's `lower_case_table_names` differs
by platform — a case-sensitive check reports that every table is missing on a
developer's Windows machine and nothing wrong on the Linux deployment.

The response names the count, not the tables. This endpoint is unauthenticated,
and a list of what a deployment is missing is a map of the database; the names go
to the log, where the operator debugging a deploy can read them.

Health checks are excluded from pino access logging — otherwise they would
dominate the log volume.