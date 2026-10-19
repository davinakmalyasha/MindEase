# Contributing

Thanks for looking. This document is short because the interesting part is
"what the gates actually check", not "how to run npm install".

## The three real gates

Most projects have a test suite. This one has three checks that are unusual, and
they are the reason a large amount of code here looks defensive. If you are about
to change something and wonder why a line is shaped the way it is, one of these
is usually the reason.

**1. The schema is the committed migration set.**
`server-go/migrations/*.up.sql` is the only source of schema truth; `cmd/migrate`
applies it and records versions in `schema_migrations`. `/api/health/db` verifies
every table the binary expects and answers 503 with `schema: drift` when one is
missing. There is no second datamodel file to diverge from the migrations.

**2. Failures are typed, and the driver's text never reaches a caller.**
Handlers return `*AppError` (`BadRequest`, `Unauthorized`, `Forbidden`,
`NotFound`, `Conflict`), or `s.Fail` with an explicit status. Anything else is
logged with the request id and answered as a generic 500. The reason is
unchanged from the Node era: a SQL-driver message names tables, columns and the
offending argument, and echoing it to an anonymous caller turns a malformed
request into a schema-fingerprinting oracle.

**3. The realtime contract is pinned by tests on both sides.**
`server-realtime/hub/*_test.go` pins the JWT claims, the origin allowlist and
the event envelope; the browser suite drives the REST side that publishes those
events. One contract, checked where it is implemented rather than by
re-parsing three languages in one test.

## Tests

```bash
cd server-go && go test ./...          # 42 Go tests across both modules
cd client && npm test                  # 52 tests, 8 files
cd server-realtime && go test -race ./...
cd client && npx playwright test       # the 12 browser journeys
```

The behavioural suite is the browser one, against the real stack — MySQL 8,
Redis, the Go API. It is required in CI's `docker` job. The Go unit tests need no
database, and all 20 migrations are
raw MySQL DDL.

```bash
cd server-go
go test ./...                  # unit tests; no database needed
```

**Before a browser run**, and after any schema change:

```bash
DATABASE_URL=mysql://... go run ./cmd/migrate   # committed migrations only
DATABASE_URL=mysql://... go run ./cmd/seed
```

The browser suite is serial and starts from seeded data; it is the behavioural
gate. The old Node integration suite (519 tests, serial, wiping between tests)
was not ported — `docs/testing.md` names that gap rather than hiding it.

## Conventions

**Commit messages.** Conventional Commits, lowercase after the scope, and the
subject says what changed rather than that something changed. The body should
explain *why*, and where a comment would normally go, put the reasoning in the
commit body — the codebase has a lot of comments that explain a decision, and
most of those decisions have a commit that says so.

```
fix(safety): the triage queue dropped an alert when the relationship lapsed
```

173 of the 181 original commits already follow this. The eight that do not are
the opening of the repository and are being left alone.

**Comments.** This codebase is heavily commented, and that is deliberate rather
than incidental: much of it is a mental-health product, and the reasoning behind
a clinical or privacy decision is the part a future contributor needs. A comment
that restates the code is noise. A comment that says why the obvious thing is
wrong is the most valuable line in the file. If you change behaviour, update the
comment that described the old behaviour — that is the main thing a stale
comment costs here.

**Localisation.** Any user-facing string goes through `next-intl` and lands in
*both* `messages/en.json` and `messages/id.json`. `client/tests/locales.test.ts`
fails on key drift, empty values, mismatched ICU placeholders, and English left
untranslated. The values are checked, not just the keys.

There is one deliberate exception: crisis hotline numbers and the official names
of the organisations behind them are byte-identical across locales, because a
mistranslated emergency number is a wrong emergency number. They are allowlisted
in the test by path.

**No `any` in new server code.** `npm run lint` currently reports 76 warnings and
0 errors; almost all of them are `no-explicit-any`. Do not add to that number.

## Working on a clinical feature

If you are touching anything that reads or writes patient data:

- **Sanitise free text on the way in.** `utils/sanitize` is `allowedTags: []`.
  Every free-text field that is rendered to somebody else goes through it.
- **Ownership is checked in the service, not the route.** The access rule for a
  clinical record belongs next to the query that reads it, so a route that
  forgets a middleware cannot accidentally skip the check.
- **Never auto-escalate.** A crisis phrase prompts a human. There is no code
  path from a patient's message to an external service, and adding one is a
  product decision that needs a human who has thought about it.
- **AI output is never generated content that reads as clinical judgement.** A
  safety plan is written by a person. `AiResult` carries `source` and
  `degradedReason` so a degraded response cannot be rendered as a real one.

## Reporting a security problem

Not in a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
