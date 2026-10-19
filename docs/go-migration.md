# Migrating the API to Go — the plan, the toolchain, and the parity strategy that makes it checkable

Status: **executed.** The Node implementation is deleted. `server-go/` is the
API — 160 route registrations, chi + database/sql over MySQL, Go 1.27.2 — and
`server-go/migrations/*.up.sql` (with `cmd/migrate`, baselined against Prisma's
bookkeeping table) is the only schema path. `cmd/seed` replaces the Node seed.
Docker compose builds the Go API and a Go migrate one-shot, CI's Docker job boots
that stack and passes all 15 browser tests in production mode, the Playwright
webServer runs the Go binary locally, and the Railway config points at
`server-go/Dockerfile`.

What remains for full parity, in the order it matters: the OpenAPI spec
rebuild and response fixtures, and a fuller port of the 519 Node tests —
an 11-test MySQL integration suite now covers the races and guards, while the
provider signature, TOTP replay, job-claim hand-back and trajectory cases
remain uncovered (named in `docs/testing.md`). SMTP delivery and web push are
wired: notifications, OTP mail and job reminders send when configured, and dead
push subscriptions are pruned.

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
| **MySQL schema and its 20 SQL migrations** | `prisma migrate deploy` runs plain SQL files; the Go process runs the same files through `golang-migrate` (after cutover — see decisions) | Low. The schema is the contract; no data migration is needed |
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
  internal/ai/              provider client (OpenAI-compatible), prompt assembly, provenance
  migrations/               the same SQL files, one source of truth
  openapi/                  generated spec, diff-checked against the Node one
```

Decisions inside this shape (router, data layer, validation) are locked in the
decisions section below.

## Toolchain and versions

Go **1.27.2** — the latest stable release (2026-10-08, a security release; the
1.27 line is current). It is pinned at three points, not hoped for:

| Where | Pin |
|---|---|
| `go.mod` | `go 1.27` plus `toolchain go1.27.2`, so a patch bump is a one-line change and a machine with an older Go self-serves the right one |
| Docker | `golang:1.27.2-alpine3.24` in the builder stage; runtime image distroless static, nonroot, `CGO_ENABLED=0` |
| CI | `go-version-file: server-go/go.mod`, module cache, and a Dependabot `go_modules` entry for `/server-go` (the `/server-realtime` one already exists) |

`server-realtime/go.mod` moves from `go 1.26` to 1.27.2 in phase 1: one
toolchain for the repository, and the realtime service picks up the 1.27.2
security fixes (`crypto/tls`, `net/http`, `os`) it does not get today.

The local machine has `go1.26.5` on PATH while `GOROOT` points at a separate
`go1.27.0` install — the skew AGENTS.md already records. Phase 1 starts by
installing 1.27.2, clearing `GOROOT`, and leaving `GOTOOLCHAIN=auto` so the
`toolchain` pin is enforced by the tool itself.

Libraries, with versions verified at planning time. `go get` pins the latest
at bootstrap and Dependabot keeps them current, so these are floors, not
numbers that rot:

| Concern | Pick | Verified |
|---|---|---|
| Router | chi `v5` | v5.5.0 (2026-10-14) |
| Validation + OpenAPI | huma `v2` on the chi adapter | v2.39.1 |
| Queries | sqlc + `go-sql-driver/mysql` | sqlc v1.31.1 |
| Migrations | `golang-migrate` v4, running the same SQL files — only after cutover (see decisions) | v4 |
| UUIDv7 | **stdlib `uuid`** (`NewV7`) | 1.27.2 |
| Auth | `golang-jwt/jwt/v5`, `x/crypto/argon2`, `pquerna/otp`, `skip2/go-qrcode`, `google.golang.org/api/idtoken` | latest |
| LiveKit access token | hand-rolled with `golang-jwt/jwt/v5` — the same reasoning as `video.service.ts`: the format is an HS256 JWT with a `video` grant, and no third-party code goes near mental-health data for twenty lines of claims | — |
| Redis | `redis/go-redis/v9` (realtime is on v9.7.3; both bump together) | v9 |
| Jobs | `robfig/cron/v3` + the internal trigger route | v3 |
| AI | `google.golang.org/genai` | latest |
| Mail / push / storage | `wneessen/go-mail`, `SherClockHolmes/webpush-go`, `aws-sdk-go-v2` | latest |
| HTML | `microcosm-cc/bluemonday` | latest |
| Logging / errors | `log/slog` + a redacting handler; stdlib errors, `appError` ported | stdlib |
| Observability | `sentry-go`; OpenTelemetry `otelhttp` wired but a no-op until `OTEL_EXPORTER_OTLP_ENDPOINT` is set; internal-only pprof listener (phase 1 — decided) | latest |
| Tests | stdlib `testing` + `go-cmp` + `testcontainers-go` (MySQL 8; Docker is already in CI) + `testing/synctest` + fuzz for the crisis-text matcher | latest |
| Lint / dev | `golangci-lint` v2, `gofumpt`, `govulncheck`, `air` (hot reload), `sqlc diff` | latest |

One routing nuance is a behavior decision, not a package choice: chi deprecated
`RealIP` for spoofing reasons (GHSA-3fxj-6jh8-hvhx). Behind Railway's proxy the
rate-limiter key must come from `middleware.ClientIPFromXFFTrustedProxies(1)`,
never `X-Real-IP` — the Node limiter derives its key from Express's trusted
proxy handling, and this is the port of that behavior.

### Go 1.27 features this plan actually uses

- **stdlib `uuid` with `NewV7`** — monotonic, RFC 9562, crypto-secure random.
  Replaces `google/uuid`; the version-nibble check the route schema performs is
  a raw byte read on the 16-byte array, and the `identifier-shape` pinned
  behavior comes along.
- **Goroutine leak profile, now generally available** —
  `/debug/pprof/goroutineleak` on the internal listener and in the realtime
  soak test. This class of bug has been found in the hub before.
- **`testing/synctest` and `httptest.NewTestServer`** — deterministic
  fake-clock tests for the job claims and rate-limit windows instead of sleeps.
- **`encoding/json` is now v2-backed with v1 semantics preserved** — the
  default keeps Node-compatible parsing, so parity holds without effort.
  Stricter behavior (duplicate keys, invalid UTF-8) is opt-in per call where a
  decision says so, and tested when it is.
- **`net/http` hardening defaults** (`Server.MaxHeaderValueCount`) and the
  `Response.Body` drain fix — free.

## Node to Go mapping

| Node (today) | Go replacement | Notes |
|---|---|---|
| Express 5, routers per resource | chi v5 | Middleware chain maps 1:1; chi keeps the per-resource router structure. Limiter keys come from `middleware.ClientIPFromXFFTrustedProxies(1)`; `RealIP` is deprecated for spoofing |
| Prisma 6 | **sqlc** over `go-sql-driver/mysql` | The queries are already SQL-shaped; sqlc makes them compile-time typed. `Prisma.PrismaClientKnownRequestError` P2002 usages become error-code checks (`mysql.MySQLError` 1062) |
| UUIDv7 (`uuid(7)` defaults) | stdlib `uuid` (`NewV7`) | Application-side generation, as Prisma's is; monotonic. Route params keep the version-nibble check |
| Zod 4 schemas | huma v2 | huma generates the OpenAPI spec from Go types; the port target is the spec `openapi.test.ts` already pins |
| `jsonwebtoken` | `golang-jwt/jwt/v5` | Already a dependency of the realtime service |
| argon2 | `x/crypto/argon2` | PHC-string compatible both ways; seeded hashes keep working |
| speakeasy (TOTP), qrcode | `pquerna/otp`, `skip2/go-qrcode` | Standard |
| `google-auth-library` | `google.golang.org/api/idtoken` | ID-token verification only |
| LiveKit token minting (hand-rolled in `video.service.ts`) | hand-rolled with `golang-jwt/jwt/v5` | Same claims, same refusal to add an SDK |
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
5. **Shadow reads before write cutover.** In the docker-compose topology, run
   both services against the same seeded database; proxy GETs to Node, compare
   with Go asynchronously, log mismatches. Writes flip only after the fixture
   matrix and the journeys are green.

## Phases and exit criteria

| Phase | Content | Exit criteria | Est. (full-time) |
|---|---|---|---|
| 0. Freeze | Tag `v0.3.0`; this document; branch cleanup | Done | — |
| 1. Skeleton | Go 1.27.2 toolchain install and the realtime bump, `server-go/` with config (all production guards ported as tests), health endpoints, slog with redaction, security headers, OTel as a no-op + internal pprof, sqlc wired, `air` + `golangci-lint`, CI job (vet, lint, `-race` tests against MySQL, govulncheck, build), Dockerfile | `go test ./...` and `golangci-lint run` green; `/api/health` and `/api/health/db` match Node bodies; config guard tests cover weak secrets and the simulator opt-in; pprof is not publicly reachable | 4–6 days |
| 2. Auth and account | register/login/refresh/logout, lockout, 2FA (enrol, verify, disable, backup codes), Google sign-in, `/account/export`, cookies with the same flags | Auth e2e journeys pass against Go; refresh rotation and one-time codes pinned by Go tests; export test passes against a seeded DB | 5–8 days |
| 3. Clinical core | appointments, scheduling, doctors directory, packages/checkout, messages, assessments, mood/wellness, risk queue, care plans, safety plans, follow-ups, reviews, notifications; realtime merged into the binary | All 12 tests pass against Go; the invariant list above is green; websocket auth and origin behavior identical | 15–25 days |
| 4. Periphery | AI (prompts, fallback chain, provenance, circuit breaker), payments (Midtrans + simulator guards), jobs/worker/cron in WIB, push, mail, admin routes, OpenAPI document | Spec diff clean; AI provenance tests green; payment simulator guards reject production config identically | 8–12 days |
| 5. Cutover | response fixture matrix, shadow reads in the docker-compose topology, staged write switch, burn-in, decommission `server/` | Fixtures match; journeys pass against the composed stack; a burn-in window with error rates and latency at the recorded baseline | 5–8 days |

Total: roughly **7–11 weeks full-time solo**, with phase 3 dominating. Treat
this as optimistic: greenfield estimates of this shape usually are.

## Decisions, locked

All decided before phase 1 begins.

1. **Placement: `server-go/` in this repository**, side by side with `server/`,
   CI runs both. One project story, one e2e suite, one deployment pipeline.
   `server/` is deleted at cutover; its history stays.
2. **The realtime service merges into the API binary.** One Go binary, one
   session contract; the websocket can still listen on its own port for a
   future split.
3. **Router and data access: chi v5 + sqlc over `go-sql-driver/mysql`.** The
   queries are already SQL-shaped, and compile-time types over explicit SQL is
   what a port most needs to be auditable.
4. **OpenAPI: huma v2.** Struct-tag validation is the closest structural
   analogue of Zod, and the spec it generates is what the diff gate compares.
5. **MySQL stays.** The 20 migrations remain the schema's source of truth.
   `golang-migrate` becomes the runner *after* cutover, with a one-time
   baseline (`migrate force <latest>`) so its bookkeeping table starts where
   Prisma's `_prisma_migrations` ended. Two runners and two bookkeeping tables
   are never live at once.
6. **Toolchain: Go 1.27.2 everywhere**, `server-realtime` included. Patch
   updates arrive through the `toolchain` directive and Dependabot.
7. **No deployment in the critical path.** There is no live environment today
   by choice; the port runs against the docker-compose topology, which is the
   oracle and the fallback. Deployment remains an independent decision that
   this migration neither blocks nor requires.
8. **Phase 1 carries the observability floor**: OpenTelemetry wired as a no-op
   until an OTLP endpoint exists, and pprof on an internal-only listener.

## CI, tooling and quality gates

The `server-go` job joins the existing CI:

- `go vet`, `golangci-lint run`, `gofumpt -l` (fail on output);
- `go test -race ./...` against MySQL 8 via `testcontainers-go` (Docker is
  already present in the `docker` job);
- `go build ./...` and the Docker image build; Trivy scans the image in
  `security.yml` like the other two;
- `govulncheck` required, mirroring the realtime job;
- `sqlc diff` — generated code that no longer matches the queries or schema
  fails;
- the spec-diff gate from the parity strategy, required for the length of the
  migration;
- `check-numbers` counts the new tree; its globs, the README counts and
  `CODEOWNERS` update in the same change that adds the first Go file;
- Makefile targets: `go-dev`, `go-test`, `go-lint`, `sqlc`, `migrate`;
- benchmarks (`-bench`) for the hub and the limiter run in CI but do not gate
  yet; a bounded `-fuzz` run for the crisis-text matcher lands with phase 4.

## Risks, ranked

| Risk | Mitigation |
|---|---|
| Reintroducing a hardened race | The invariant list is part of every phase's exit criteria; each ported as a Go test against real MySQL |
| Response shape drift | Fixture matrix + journeys; error-body shape pinned explicitly |
| Cookie/CSRF parity | Port with tests before any domain work; the client is not modified as a workaround |
| Rate-limit semantics drift | Port the store tests first (prefix isolation, window math, client-IP derivation) |
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
- Not a deployment project. Deployment is a separate, deferred decision; the
  port neither requires nor blocks it. The docker-compose topology stands in
  for every phase after the skeleton, and the Node stack stays runnable the
  whole time.

## Definition of done

1. All 12 e2e tests pass against the Go service on the docker-compose topology
   (and in a deployed environment, whenever that decision lands).
2. Spec diff and response fixtures are clean and stay in CI.
3. The ported invariant tests are green against real MySQL, with the same
   concurrency tests that caught the original bugs.
4. Realtime runs inside the Go binary; the session contract has one source.
5. `server/` is deleted; the README, ARCHITECTURE.md, operations.md and the
   gates describe the Go system only.
6. Sessions issued before the cutover still work after it.
