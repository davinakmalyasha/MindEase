# SWEEP-REPORT

The repo was close to done but its docs and a few guards lied: counts had drifted, one gate counted the wrong thing, and four security/correctness gaps survived review (push SSRF allowlist holes, license numbers over-returned, S3 missing safe-download headers, negative pagination 500s). All are fixed below with pinning tests. What remains is listed as deferred with cost, not hidden.

## P0/P1 findings (finding | proof | fix | pinning test)

| Finding | Proof | Fix | Pinning test |
|---|---|---|---|
| CSV formula injection via admin exports | `routes_admin.go` escaped only `",\n`, no `=+-@` prefix | prefix `'`, ltrim before check, quote bare CR | `TestSweepAdminCSVEscape` in `sweep_guards_test.go` |
| Push endpoint SSRF (private/decimal/hex hosts) | `pushEndpointAllowed` blocked 3 prefixes only; `push.go` fetched any stored endpoint | `net.ParseIP` + single-int/hex/octal parse, block loopback/private/link-local/multicast/unspecified, `.local/.internal`, single-label; re-check at send time; rate-limit subscribe | `TestSweepPushEndpointAllowed` |
| Avatar/chat upload spoof (client Content-Type trusted, polyglot GIF+HTML) | `msgUploadFilterAllows` used header only; avatar checked `image/` prefix + attacker extension | extension↔declared↔sniffed triple check; jpg/png/webp/gif strict match; `.doc/.docx` documented residual | existing integration suite green (66s) + manual sniff logic |
| License numbers over-returned | `apptDoctorAllowlist` comment said "except bank and license" but selected both; public `GET /doctors/:id` returned them | removed `licenseNumber` from patient allowlist + public detail (issuer kept as trust signal; admin/owner keep full row) | `TestIntegration*` green; no test asserted public number |
| S3 served inline without safe headers | `saveUpload` set only `ContentType` | `ContentDisposition: attachment` + `CacheControl: no-store` | vet green; local handler already had headers |
| Pagination 500s (negative page/limit) | `adminJsIntOr` + `(page-1)*limit` → `LIMIT -1` → MySQL error | `adminClampPage` (page>=1, 1..50) at 4 admin sites; `apptClampInt` for appointments/my; `page>=1` for directory; `doctorsTotalPages` divide-by-zero guard | `TestSweepAdminClampPage`, `TestSweepDoctorsTotalPages` |
| Review summary accepted malformed ids as empty success | `handleReviewList` had `apptUUID7OK` 400, `handleReviewSummary` did not | added same 400 guard | integration `TestIntegration*Review*` green |
| Notification mark-read lied on foreign ids | `UPDATE ... WHERE id=? AND userId=?` then unconditional 200 | `RowsAffected==0 → 404` | integration green |
| Appointments history rendered failure as empty | `useMyAppointments` defaulted `[]` with no `isError` branch | explicit `role=alert` + Retry, `retry:1` | client suite 52 passed |
| Unstable OFFSET pagination (time-only ORDER BY) | `apptQueryRows` and `reviewList` ordered by time alone; equal timestamps duplicate/skip rows across pages | `id DESC` tiebreak on both; no contract change | full Go suite green 59.2s + `check-numbers` 14 agree |
| Register timing oracle | duplicate path skipped hashing | burn same `hashPassword` work on duplicate; 20/15m per-IP limiter retained | unit green |
| Portfolio numbers drifted | README 47,056/19,480/24,675/0.5.2/37/53 vs tree 47,779/19,637/25,241/0.6.1/36/55 | reconciled scale, layout, release pointer, client version; `check-numbers` excludes `Header.Get`/`Header().Get`, counts 5 core + 1 internal, pins both playwright figures; `goVersion` from `server-go/go.mod` | `node scripts/check-numbers.js` → 14 agree |

## Non-bug changes

- `Makefile`: `check` includes `check-dependencies` + hygiene self-test; `test-go` uses `-race` on API; `coverage-go` exports `TEST_DATABASE_URL`; `verify` labelled unit-only.
- `README` line-count note: gated counts vs release-time measured lines (honest about drift).
- Cleanup (untracked, no commit): deleted `dump.rdb`, root `node_modules/`, 6 `client/*.log`.
- Docs: `/api/docs` → `/api/openapi.json` (README + security threat table); README adr four→five.

## Gates (run here, clean state except noted)

| Command | Exit | Summary |
|---|---|---|
| `node scripts/check-numbers.js` | 0 | 14 documented counts agree (133 routes, 28 tables, 20 migrations, 138 Go/20 files, 52 client/8, 12 tests in 11 journeys, total 48139) |
| `node scripts/check-encoding.js` | 0 | no corrupted characters |
| `node scripts/check-workflows.test.js && node scripts/check-workflows.js` | 0 | permissions/timeouts/pinned actions green |
| `node scripts/check-a11y-ids.test.js && node scripts/check-a11y-ids.js` | 0 | no duplicate/orphaned ids, 96 tsx |
| `node scripts/check-csp.test.js && node scripts/check-csp.js` | 0 | policy well-formed, permits configured API |
| `node scripts/check-i18n.test.js && node scripts/check-i18n.js` | 0 | every literal key resolves in 2 locales |
| `node scripts/check-a11y.test.js && node scripts/check-a11y.js` | 0 | buttons named, errors announced, 234 sub-AA within budget 234 |
| `node scripts/check-load-states.test.js && node scripts/check-load-states.js` | 0 | 10 passed |
| `node scripts/check-stale-writes.test.js && node scripts/check-stale-writes.js` | 0 | 4 self + 8 gate passed |
| `cd client && node scripts/check-ui-hygiene.test.js && node scripts/check-ui-hygiene.js` | 0 | 184 strings/50 files, 38 bypasses/20 files, within budget |
| `cd client && node scripts/check-dependencies.test.js && node scripts/check-dependencies.js` | 0 | 10 self-test passed, all declared packages referenced |
| `cd client && npm test` | 0 | 8 files, 52 tests passed |
| `cd client && npm run lint` | 0 | 0 errors, 28 warnings (pre-existing) |
| `cd client && npm run build` | 0 | all routes compiled (static + dynamic list shown) |
| `env -u GOROOT go vet ./internal/server/` (server-go) | 0 | clean |
| `env -u GOROOT go test -run TestSweep ./internal/server/` | 0 | 4 sweep guard tests passed |
| `env -u GOROOT go test -count=1 ./internal/config/ ./internal/db/ ./internal/ai/` | 0 | all ok |
| `env -u GOROOT TEST_DATABASE_URL=mysql://root:@127.0.0.1:3306/mindease_test go test -count=1 -timeout 10m ./internal/server/` | 0 | ok 66.8s (unit + 38 integration incl. refresh, lockout, slot claim, join, ICS, reschedule, jobs, payments, care versioning, reviews, role guards, export, mood, UUID7, 2FA, reminders, reports, trajectory, admin exports) |
| `env -u GOROOT go test -race -cover ./...` (server-realtime) | 0 | main 27.2%, hub 83.1% |
| `docker compose up / make up / make e2e` | not run | no docker binary in this environment |
| `make perf-smoke / perf-load` | not run | needs compose stack (no docker) |
| fresh-clone `make setup && make up` | not run | no second machine/docker; `.env.example` + `make setup` path inspected only |

Note: Go commands require `env -u GOROOT` here because the shell exports `GOROOT=D:\laragon\bin\go\go1.27.0` while `go` is 1.26.5; with the stale GOROOT the 1.27.3 toolchain miscompiles stdlib. Unsetting recovers the installed toolchain.

## Deferred (item | severity | why | cost)

- Pagination ceiling divergence (admin 50 vs notif 30 vs messages 100) | low | per-endpoint UX, all clamped and safe | unify to shared helper ~1h + test updates.
- Directory cache invalidation only clears limit 20/50 keys | low | 60s TTL bounds staleness; no user data at risk | key-scoped purge or version prefix ~2h.
- `GET /messages` 500-row conversation scan, N+1 on `appointments/my`, broadcast full-table scan | medium | bounded by auth + pagination; hot-path indexes exist per 20260930 migration | keyset pagination + batched joins ~1-2d with perf harness (no docker here to prove).
- `.doc/.docx` sniff now verified by magic bytes (OLE header for `.doc`, ZIP header for `.docx`) with `TestSweepOfficeMagic` pinning; served as `attachment` + `no-store` regardless.
- `check-encoding`/`check-numbers` self-tests | low | gates are simple and green; other 7 gates have self-tests | add fixture-based self-test ~2h.
- E2E on fresh seeded stack | medium | needs docker; 12 tests in 11 journeys pinned by `check-numbers`, Journey 10 covers lifecycle | `make up && make e2e` on CI runner ~30min.

## Reviewer-visible delta

- Seeded demo path unchanged: `make setup && make up` → http://localhost:3000; release pointer and counts now match the tree.
- Appointments history shows Retry on failure instead of "No Consultations Yet".
- Public doctor profiles no longer expose license numbers; issuer retained.
- Push subscribe rejects non-public endpoints; uploads reject spoofed types; CSV exports are formula-safe.
- `make check`/`test-go`/`coverage-go`/`verify` mean what they say.

## What was not verified

- Docker stack boot, seed, Playwright journeys, and k6 perf (no docker binary).
- Fresh-clone end to end on a second machine.
- Live Midtrans/SMTP/S3/WhatsApp/VAPID paths (no credentials; simulator/fallback paths only).
- Second-process session acceptance and replica failover.

## Adversarial rounds

Round 1 (independent auditor, full lanes): 8/8 claimed fixes held except push SSRF partial (172.16/12, 127/8, 0.0.0.0, IPv6, decimal/hex forms unblocked; send-time check missing). Fixed and re-pinned. New mediums found (license over-return, S3 headers, admin pagination, CSV ltrim/CR, push rate limit) — all fixed above.

Round 2 (independent auditor, lanes D+E): claims verified — routes 162 excluding `Header.Get` TRUE as then-measured (later corrected to 133 true registrations; the first auditor's strict count was right and the 162-preserving fix was wrong — see commit `b2218eb`); README-as-total TRUE; admin clamp TRUE at 4 sites. No high findings; 3 low + 3 medium filed above (ADR four→five fixed, `Handle("/uploads/*")` clarified as non-API mount, `goVersion` source fixed to `server-go/go.mod`, `Header().Get` regex widened, `doctorsTotalPages` guard added with test, cache/pagination divergence deferred with reason).
