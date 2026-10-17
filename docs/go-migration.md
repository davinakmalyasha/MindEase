# Migrating the API to Go — a plan, and the parity strategy that makes it checkable

Status: **draft for discussion. Nothing in this document is built.** The Node
API is the system today, frozen at `v0.3.0` as the reference. This document
covers why a port is on the table, what exactly would move, what must not
change, how each phase is verified, and the decisions that are still open.

It exists because "rewrite the backend in Go" is a sentence that means at least
three different projects, and only one of them is worth the cost this one would
charge.

## Why this is worth considering at all

- **One language for the backend, eventually.** The realtime service is already
  Go (811 source lines, 32 tests across 5 files). A Go API merges two deploy
  shapes and two toolchains into one, and a single static binary on Railway is a
  simpler operational story than Node plus `npx prisma migrate deploy`.
- **The realtime merge becomes trivial.** Today the session contract — JWT
  claims, the Redis event envelope, the string user ids — is duplicated between
  TypeScript and Go and kept aligned by a contract test. One codebase deletes
  the duplication.
- **Portfolio signal, honestly stated.** "Go API, hardened, with parity tests"
  is a different signal than "Node API". This repository already proves Go at
  the edges; a full port proves it at the center.

## Why the answer may still be no

- **The API was just hardened.** Race fixes (checkout claim, follow-up,
  refund, backup codes, video rooms, triage acks), UUIDv7 everywhere, durable
  job claims, optimistic concurrency on the plan editors, read auditing — each
  exists because it was found, reproduced and pinned by a test. A port is the
  largest possible change to the most hardened surface in the repository.
- **The test suite is the asset, not the code.** 519 static tests in 43 files
  describe behavior that took months to get right. A port that drops them and
  keeps the code has inverted what is valuable.
- **I/O, not HTTP, is the bottleneck.** Express is not why any request in this
  system is slow. MySQL and the AI calls are. The performance argument for Go
  does not apply here.
- **The cost is real.** ~17k lines of API source and ~11.9k lines of test
  source, 128 route handlers, 28 models. See the effort estimate below; it is
  not a weekend.

The plan below exists to convert those objections into engineering controls
rather than reasons to stop. If those controls are not worth building, the
answer is no.

## What carries over without translation

| Carried over | Why | Risk |
|---|---|---|
| **MySQL schema and its 20 SQL migrations** | `prisma migrate deploy` runs plain SQL files; the Go process can run the same files through `golang-migrate` (or keep running them in the Node start step during the transition) | Low. The schema is the contract; no data migration is needed |
| **The JWT contract** | HS256, same `JWT_SECRET` across API, realtime and the web middleware (`client/proxy.ts`). A Go signer/verifier already exists in `server-realtime` | Low. Sessions survive the cutover by construction |
| **Redis** | Same instance, same keyspace. Rate-limit counters, pub/sub, job locks | Medium for the limiter: the store's `prefix` is what prevents stacked-limit double counts — the Go limiter must isolate per route class the same way |
| **The Playwright suite** | 12 tests in 11 journeys, driving the real client against real credentials and a seeded database | This is the single strongest parity oracle; it is written against the HTTP contract, not the implementation |
| **Docker and deploy patterns** | Multi-stage non-root images, `start.sh` runs migrations then the server, `/api/health` and `/api/health/db` | Low |
| **The CI gate philosophy** | Counts checked against the tree, coverage floors, UI hygiene, dependency scanners, pinned actions | The gate scripts are Node and stay; they run against the repo, not the server |

## What must be rebuilt, and against what spec

The Node implementation is the specification while both exist. The database
schema and the client are the judges. Three contract surfaces are explicit
today and must be preserved byte-for-byte where they matter:

1. **Request validation.** `server/src/schemas/*` in Zod is also the source of
   the OpenAPI document (`GET /api/docs`, pinned by `openapi.test.ts`). The Go
   service must produce the same spec for the same routes.
2. **Response shape.** The OpenAPI document deliberately does not describe
   response bodies, so they are not machine-checked today. Parity for responses
   comes from the Playwright journeys plus new response fixtures captured from
   the Node service (see phase 5).
3. **Failure semantics.** Status codes, the error body shape, and the
   distinctions the tests pin: 400 vs 401 vs 403 vs 404 vs 409 vs 423. A port
   that flattens these is a regression even if every happy path works.

## Target architecture

One repository, one new directory (`server-go/`) developed alongside `server/`
until cutover. Not a new repository: the e2e suite, the gates, the CI
workflows, the docs and the deployment configuration all live here, and they
are most of what makes the port verifiable.

```
client/                     unchanged, throughout
server/                     the reference. Frozen after phase 1 unless a bug fix is needed
server-go/
  cmd/api/                  the one binary: HTTP + websocket + job scheduler
  internal/config/          env parsing with the same production guards (weak secrets,
                            simulator opt-in, S3 warning) - ported as tests first
  internal/http/            router, middleware: auth, roles, rate limit, CSRF, CORS,
                            request logging with the same redaction rules
  internal/store/           sqlc-generated queries + hand-written transactions
  internal/domain/          one package per bounded area, mirroring the services
  internal/realtime/        the hub, moved from server-realtime
  internal/jobs/            scheduler + claim semantics + the internal trigger route
  internal/ai/              Gemini client, prompt assembly, fallback chain, provenance
  migrations/               the same SQL files, one source of truth
  openapi/                  generated spec, diff-checked against the Node one
```

Decisions inside this shape (router, data layer, validation) are in the open
decisions section.

## Node to Go mapping

| Node (today) | Go candidate | Notes |
|---|---|---|
| Express 5, routers per resource | chi (or stdlib `net/http` routing) | Middleware chain maps 1:1; chi keeps the per-resource router structure |
| Prisma 6 | **sqlc** over `go-sql-driver/mysql` | The queries are already SQL-shaped; sqlc makes them compile-time typed. `Prisma.PrismaClientKnownRequestError` P2002 usages become error-code checks (`mysql.MySQLError` 1062) |
| Zod 4 schemas | huma v2 (or validator + hand-written spec) | huma generates the OpenAPI spec from Go types; the port target is the spec `openapi.test.ts` already pins |
| `jsonwebtoken` | `golang-jwt/jwt/v5` | Already a dependency of the realtime service |
| argon2 | `x/crypto/argon2` | PHC-string compatible both ways; seeded hashes keep working |
| speakeasy (TOTP), qrcode | `pquerna/otp`, `skip2/go-qrcode` | Standard |
| `google-auth-library` | `google.golang.org/api/idtoken` | ID-token verification only |
| `redis`, express-rate-limit store | `redis/go-redis/v9` + a hand-written limiter | The limiter's fixed windows and route classes must match; the prefix isolation is the point |
| node-cron + the worker | `robfig/cron/v3` + the same `/api/internal/jobs/:name` trigger | Claim/lease semantics port as-is; WIB scheduling windows port as time.LoadLocation |
| `@google/generative-ai` | `google.golang.org/genai` | Prompts and the rules-fallback chain are behavior; port with the provenance tests |
| nodemailer | `wneessen/go-mail` (or net/smtp) | Templates unchanged; SMTP throws in production when unset, same as now |
| web-push | `SherClockHolmes/webpush-go` | VAPID keys are configuration, not code |
| `@aws-sdk/client-s3` | `aws-sdk-go-v2` S3 client with base endpoint | R2/MinIO compatible; `forcePathStyle` equivalent |
| pino + redaction | `log/slog` + a redacting handler | `access-log-redaction.test.ts` is the spec |
| Sentry | `getsentry/sentry-go` | Same DSN plumbing |
| multer, sanitize-html, helmet | stdlib multipart, `microcosm-cc/bluemonday`, hand-written headers | The CSP and security-header set is pinned by `check-csp.js` against the client; it must match |

## The parity strategy (this is the part that decides whether the port works)

1. **The Playwright suite runs unchanged against the Go API.** `client/.env`
   points `NEXT_PUBLIC_API_URL` at whichever service; the journeys do not know
   the difference. Every phase exits when 12/12 pass against Go.
2. **Spec diff in CI.** `GET /api/docs` from both services, normalized and
   diffed as a required check during the migration. Request shapes cannot
   silently drift.
3. **Ported invariant tests, not ported files.** The 519 tests are behavior
   specifications. The ones that pin invariants that were bugs before — the
   list below — get re-expressed in Go against a real MySQL, and each is
   marked with what it prevents:
   - one `PackagePurchase.liveKey` claim; P2002 → 409; reuse after settle
   - one refund per appointment; concurrent cancellation is idempotent
   - follow-up accept/decline cannot both land
   - one backup code spend per code; refresh rotation invalidates the old token
   - one video room per appointment under concurrent joins
   - one audit entry per triage ack under concurrent acks
   - safety plan and care plan versioned writes: 409, never silent overwrite
   - mood entry one-per-day is a unique constraint, not a check-then-create
   - job claims: a failed nudge hands the claim back; the weekly report is
     per patient and catches up missed Mondays
   - rate-limit prefix isolation: stacked limiters do not double count
   - UUIDv7 on every id; no numeric id anywhere in a response
   - GDPR export contains every table that holds user rows
4. **Response fixtures.** For a matrix of authenticated requests (one per role
   per resource), capture Node responses into versioned JSON fixtures and
   assert the Go service matches after normalization (timestamps, generated
   ids). This covers the responses the OpenAPI document does not describe.
5. **Shadow reads before write cutover.** In staging, run both services
   against the same seeded database; proxy GETs to Node, compare with Go
   asynchronously, log mismatches. Writes flip only after the fixture matrix
   and the journeys are green.

## Phases and exit criteria

| Phase | Content | Exit criteria | Est. (full-time) |
|---|---|---|---|
| 0. Freeze | Tag `v0.3.0`; this document; branch cleanup | Done | — |
| 1. Skeleton | `server-go/` with config (all production guards ported as tests), health endpoints, slog with redaction, security headers, CI job mirroring the realtime job (vet, race tests, govulncheck, build), Dockerfile | `go test ./...` green; `/api/health` and `/api/health/db` match Node bodies; config guard tests cover weak secrets and the simulator opt-in | 3–5 days |
| 2. Auth and account | register/login/refresh/logout, lockout, 2FA (enrol, verify, disable, backup codes), Google sign-in, `/account/export`, cookies with the same flags | Auth e2e journeys pass against Go; refresh rotation and one-time codes pinned by Go tests; export test passes against a seeded DB | 5–8 days |
| 3. Clinical core | appointments, scheduling, doctors directory, packages/checkout, messages, assessments, mood/wellness, risk queue, care plans, safety plans, follow-ups, reviews, notifications; realtime merged into the binary | All 12 tests pass against Go; the invariant list above is green; websocket auth and origin behavior identical | 15–25 days |
| 4. Periphery | AI (prompts, fallback chain, provenance, circuit breaker), payments (Midtrans + simulator guards), jobs/worker/cron in WIB, push, mail, admin routes, OpenAPI document | Spec diff clean; AI provenance tests green; payment simulator guards reject production config identically | 8–12 days |
| 5. Cutover | response fixture matrix, shadow reads in staging, staged write switch, burn-in, decommission `server/` | Fixtures match, journeys pass in production topology, one week burned in with error rates and latency at baseline | 5–8 days |

Total: roughly **7–11 weeks full-time solo**, with phase 3 dominating. Treat
this as optimistic: greenfield estimates of this shape usually are.

## Open decisions

Each needs an answer before phase 1 starts. My recommendation is first.

1. **Where does the Go service live during the migration?**
   - *(Recommended)* `server-go/` in this repository, side by side, CI runs
     both. One project story, one e2e suite, one deployment pipeline. Delete
     `server/` at cutover; its history stays.
   - A new repository. Cleaner standalone Go signal, but the e2e suite, gates
     and CI all have to be rebuilt or synchronized across two repos.
2. **Does the realtime service merge into the API binary?** *(Recommended:
   yes.)* One binary, two listeners or one; the JWT/Redis contract duplication
   disappears. The counter-argument — independent scaling of websocket
   connections — does not apply at this scale, and a single binary can still
   expose the websocket on its own port for a future split.
3. **Router and data access.** Chi + sqlc (recommended), stdlib routing + sqlx,
   or a batteries-included framework (echo/gin) + GORM. The recommendation
   optimizes for explicit SQL (the queries are already SQL) and compile-time
   types.
4. **OpenAPI generation.** huma (recommended) versus hand-written specs
   verified by the same diff gate. huma's struct-tag validation is the closest
   structural analogue of Zod.
5. **Keep MySQL.** *(Recommended: yes.)* No data migration, no dual-write
   risk, the 20 migrations stay the schema's source of truth. Reconsidering
   Postgres is a separate project decision that would multiply this one.
6. **When relative to the deployment plan.** Recommended order: deploy the
   Node `v0.3.0` demo first, then port with the deployed version as the live
   oracle and fallback. The portfolio has something to show while the
   migration runs; the migration gets a production comparison target.

## Risks, ranked

| Risk | Mitigation |
|---|---|
| Reintroducing a hardened race | The invariant list is part of every phase's exit criteria; each ported as a Go test against real MySQL |
| Response shape drift | Fixture matrix + journeys; error-body shape pinned explicitly |
| Cookie/CSRF parity | Port with tests before any domain work; the client is not modified as a workaround |
| Rate-limit semantics drift | Port the store tests first (prefix isolation, window math) |
| MySQL driver differences (time, JSON, decimals, charset) | Connection parameters pinned (`parseTime`, timezone, utf8mb4); trajectory and analytics fixtures cover decimals and dates |
| AI behavior drift | Prompts, model config, fallback classification and provenance are ported with their existing tests re-expressed |
| Job claim semantics drift | The claim/lease tests port first; the Node worker keeps running (unmodified) until Go claims are proven |
| Effort overrun | Phases are independently valuable; stopping after any phase leaves a working partial system and the Node API untouched |
| Two systems drifting during migration | `server/` is frozen for features after phase 1; bug fixes land in both, or wait |

## What this migration is not

- Not a client rewrite. The Next app does not change except for env values.
- Not an architectural redesign. Same processes, same database, same Redis,
  same HTTP contract, same deployment shape. Bug-for-bug parity is the goal;
  deliberate fixes are separate, listed and tested.
- Not a microservices split, not GraphQL, not an event bus, not Postgres.
- Not an excuse to skip the deployment. The Node `v0.3.0` is deployable and
  should be deployed while this plan runs.

## Definition of done

1. All 12 e2e tests pass against the Go service in the production topology.
2. Spec diff and response fixtures are clean and stay in CI.
3. The ported invariant tests are green against real MySQL, with the same
   concurrency tests that caught the original bugs.
4. Realtime runs inside the Go binary; the session contract has one source.
5. `server/` is deleted; the README, ARCHITECTURE.md, operations.md and the
   gates describe the Go system only.
6. Sessions issued before the cutover still work after it.
