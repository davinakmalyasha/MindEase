# Contributing

Thanks for looking. This document is short because the interesting part is
"what the gates actually check", not "how to run npm install".

## The three real gates

Most projects have a test suite. This one has three checks that are unusual, and
they are the reason a large amount of code here looks defensive. If you are about
to change something and wonder why a line is shaped the way it is, one of these
is usually the reason.

**1. Schema drift is a build failure.**
`npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel
prisma/schema.prisma --exit-code` runs in CI. The database is built purely from
the committed migrations; if the datamodel and those migrations disagree by so
much as a column, the build fails.

This caught three real bugs. One of them — `RiskAlert.resolvedById` — was
declared in the datamodel and written by the service, but no migration created
the column, so the triage queue threw a `PrismaClientValidationError` against
any database built from migrations. It survived because the test suite had never
been run against one.

**Consequence for you:** an index or a column that exists only in a migration is
drift. Declare it in `schema.prisma` too, with a comment saying which query it
serves.

**2. Controllers may not derive HTTP status from a message.**
`server/tests/error-status.test.ts` scans `src/` and fails if a service throws a
bare `new Error(...)` whose text a controller turns into a status code. Use
`badRequest` / `forbidden` / `notFound` / `conflict` from `utils/appError`, so
the status travels on the type.

The reason is that `publicMessageFor` has to decide whether an arbitrary
`Error`'s text is safe to show a client, and it does that by pattern-matching
Prisma and driver strings. It works, but it is the kind of inference that
produces a stack trace in a response body the first time a dependency changes
its error format.

**3. The realtime contract is checked across three languages.**
`server/tests/realtime-contract.test.ts` re-parses the TypeScript event union,
the Go structs' JSON tags, and the client's fan-out map, and fails if they
disagree. Three implementations of one contract, one assertion.

## Tests

```bash
cd server && npm test          # 427 tests, 33 files
cd client && npm test          # 46 tests, 6 files
cd server-realtime && go test -race ./...
```

The server suite needs a real MySQL 8. It is not mocked, and it is not SQLite —
the provider is a literal `mysql` in `schema.prisma` and all 15 migrations are
raw MySQL DDL.

```bash
cd server
npm run test:db                # sync the test schema
npm test
```

**Before the first run**, and after any schema change:

```bash
npx prisma migrate deploy      # builds the schema from committed migrations only
```

`prisma db push` is for the test database only. It is never used against
anything you care about, and the reason is in the README's known-limitations
section along with a migration that a `db push` would have hidden.

The suite is deliberately serial (`fileParallelism: false`) and wipes every table
before and after each test. At 427 tests that is a few minutes, not a few
seconds. Running one file while another is running will interfere with it.

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
