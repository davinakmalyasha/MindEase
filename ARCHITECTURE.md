# Architecture

How MindEase is put together, and why the load-bearing decisions went the way
they did. The tradeoffs behind individual choices are in
[docs/adr](docs/adr/); this document is the map.

## What this is

A mental-health telehealth platform. Patients discover and book with
psychologists, video or voice consultations run in a browser, and the clinical
surface is longitudinal: a risk queue for the clinician, a care plan and a
safety plan for the patient, screening instruments tracked over time.

The organising question for every design decision here is *what does a mental
health product need that a generic telehealth CRUD app does not* — clinical
safety, continuity between sessions, and honest disclosure about who is
treating you. Generic booking polish is deliberately not a differentiator
here, and several features were declined on that basis; see
[ADR-0003](docs/adr/0003-payment-abstraction.md) and the "not built" section at
the end.

## Processes

```
                    ┌──────────────────────────────┐
   browser ────────▶│  client/   Next.js 16         │
                    │  App Router, React Query      │
                    │  proxy.ts = session gate      │
                    └───────┬──────────────┬───────┘
                     HTTPS  │              │  WSS
                            ▼              ▼
        ┌───────────────────────────┐   ┌────────────────────────┐
        │ server-go/  Go 1.27 API   │   │ server-realtime/  Go  │
        │ chi · MySQL · slog        │──▶│ gorilla/websocket     │
        │ :5000                     │   │ hub: caps, origin     │
        └────┬──────────┬───────────┘   └───────────┬────────────┘
             │          │                           │
             ▼          ▼                           ▼
        ┌─────────┐  ┌─────────┐              ┌──────────┐
        │  MySQL  │  │  Redis  │──────────────▶│ pub/sub  │
        │  8.4    │  │  7      │  mindease:events   │
        └─────────┘  └─────────┘              └──────────┘
             │
             ▼
      ┌──────────────┐
      │ DeepSeek 4.1 │  every call carries AiResult provenance
      │ Flash        │  circuit breaker: 5 failures / 60s
      └──────────────┘
```

Three deployables, deliberately. The websocket service is a separate process
because its failure mode is different — a dead socket is invisible to a health
check on the API — and because a Go binary holds a few thousand sockets in a
footprint a Node process would not. See
[ADR-0001](docs/adr/0001-realtime-transport.md).

## Layering

```
internal/server/routes_*.go  HTTP shape only: path, middleware order, validation
internal/server/*.go         business logic and every authorisation check
internal/config              env parsing with the production guards
internal/db                  pool, DSN parsing, query helpers
internal/migrate             the only schema runner, embedded migrations
```

Controllers contain no business logic and services contain no HTTP. The rule
that is actually load-bearing: **every authorisation check lives in a service**,
so a route that forgets a middleware cannot leak data. `clinicalSafety`, the
care-plan service and the risk queue each re-implement the same
"does this clinician treat this patient" check independently rather than sharing
a helper, because a shared helper with a subtly different default is how one of
them ends up wrong.

## Authentication and the session chain

Four credentials, and it matters which is which:

| Credential | Lifetime | Purpose | Verified by |
|---|---|---|---|
| `accessToken` cookie | 15 min | REST requests | API |
| Refresh token | 7 days | Mint new access tokens | API, stored SHA-256 hashed |
| `ws-ticket` | 30 s | Open a websocket | Realtime, purpose-scoped |
| LiveKit video token | Session window | Join one room | LiveKit, room-scoped |

`JWT_SECRET` is the only secret shared by all three processes and must be
byte-identical across them; changing it invalidates every session.

The websocket handshake is authenticated **before** the upgrade, and the Go hub
switches on the token's `purpose` claim: an `access` token is only accepted with
`TotpVerified` set, and anything that is not `access` or a ws ticket is refused.
Without that switch the realtime channel was a route around the REST two-factor
gate, and it carries SOS alerts, risk alerts and private chat.

CSRF is a double-submit header on every mutating request, layered *after* the
rate limiter so an unauthenticated flood cannot skip it. The one exemption is the
payment webhook, which is authenticated by provider signature instead because a
provider cannot present a cookie.

## Errors

`AppError` carries the status. The reason it exists: controllers used to derive
a status by matching the thrown message against a list of fragments, so any new
client-facing message silently became a 500 and any message containing a trigger
word could not be worded freely.

Only a typed `*AppError` is shown to a caller with its own message and status;
anything else is logged with the request id and answered as a generic 500. A
driver message with table and column names is a schema-fingerprinting oracle.
The Go port replaced the old message-matching backstop with the type system, so
there is no substring rule left to drift.

## AI, and why provenance is contractual

Every AI call returns `AiResult<T>` carrying `source` (`model` | `fallback`) and
an optional `degradedReason`. A bare string from an AI call path is not
representable. Several features degrade to deterministic local output when
the provider is unavailable, and that is a legitimate outcome — but it was previously
invisible, so a patient could not tell whether they were reading something
personalised or a template.

A circuit breaker (5 consecutive failures, 60 s cooldown) stops every request
paying a 20 s timeout against a dependency already known to be down. Crisis
support replies are the one deliberate exception to disclosure: they are fixed
safety instructions and are *not* labelled as canned, because the one message
that must not look automated should not look automated.

Full rationale, including the decision to run crisis triage on free text with a
regex rather than a model: [ADR-0002](docs/adr/0002-ai-provenance.md).

## Clinical safety

The most safety-critical surface in the product, and the part with the most
opinionated code.

A non-zero answer to PHQ-9 item 9 is treated as a disclosure. Three further
sources feed the same queue: the SOS button, crisis phrasing in a
patient-to-clinician message, and a sustained mood decline detected daily by
the check-ins job. All four land in one `RiskAlert` table, which is
the only triage worklist a clinician works. A disclosure from a patient with
no assigned clinician is recorded as unassigned and pages the admins, and an
admin can acknowledge and resolve it — "the decline nudge notifies the
patient" and "a clinician sees a declining patient" are both true, through the
queue rather than around it.

Two state transitions, deliberately distinct. `acknowledgedAt` means a human has
seen it; `resolvedAt` means it is dealt with. The queue defaults to *unresolved*
— filtering on unacknowledged means an alert vanishes from the list the moment a
clinician clicks acknowledge, which is the opposite of what a worklist is for.

Priority is computed server-side and returned as a number. Level leads ahead of
acknowledgement, because acknowledging is not resolving and a still-urgent
disclosure must not sit below a routine one just because someone glanced at it.

A match is never an action. Nothing contacts an emergency service; the alert
prompts a human. `AccountService` retains `RiskAlert` rows through account
deletion in anonymised form, because the fact that a disclosure happened is
clinically relevant to whoever treats that patient next.

## Longitudinal records

`CarePlan` is owned by the **patient**, not the clinician — clinicians leave and
a plan has to survive that. A clinician can add a goal but cannot rewrite the
document. Goals can be `dropped` as well as `achieved`, so a goal abandoned
because it was wrong stays distinguishable from one that was met.

`SafetyPlan` is one row per patient, written by the patient or their clinician
together, and **never generated**. There is no "write this for me", because a
support bot offering to author someone's crisis plan has misunderstood what the
document is for. One row rather than versions, because during a crisis the last
thing anyone needs is to choose the current one.

## Video

LiveKit, with an ephemeral room-scoped token minted server-side inside the
existing `joinRoom` path. Only the appointment's patient and clinician can mint
one, and the appointment-time gate is unchanged: the room opens 15 minutes early
and closes an hour after the end, and a token is scoped to exactly that window.

The token is minted with `golang-jwt` rather than a vendor SDK. A LiveKit
access token is an HS256 JWT with a video claim; minting it directly is ~20
lines, keeps a new third-party package out of a platform holding health data,
and is testable without Docker or a LiveKit account.

`meet.jit.si` remains selectable as a degraded fallback (`VIDEO_PROVIDER=jitsi`)
so a deployment without LiveKit configured still works. It is a real downgrade —
an unguessable-but-unauthenticated URL — so the API reports it on every join and
the client says so on screen before the session starts.

## Data model notes

28 tables, no enums. Every status is a `String` with the legal values in a
comment, which is why ordering cannot be done in SQL for `RiskAlert.level` and
why the sort happens on a bounded page in the service.

`MoodEntry` carries a `moodDate` string column in the user's own timezone with a
unique key on `(userId, moodDate)`, which makes "one log per day" a database
invariant rather than a convention.

### Known deviations

**Sequential integer ids are no longer exposed.** The deviation recorded here
was closed: every primary key is UUIDv7 and every id-typed column is a string,
so there is no internal sequential identifier in any response. The destructive
migration and its rationale are in `docs/roadmap.md` (theme 1).

**`code.md` was removed.** It described a Go/Gin/raw-SQL architecture that was
never built. Its zero-trust threat model survives in the services and ADRs.

## Testing

| Suite | Count | Runs against |
|---|---|---|
| Go API | 74 tests, 13 files (24 MySQL integration) | Unit: config guards, tokens, hashing; integration: claims, rotation, audit, exports |
| client | 52 vitest, 8 files | jsdom |
| realtime | 32 tests, 5 files | In-memory, `-race` |
| e2e | 12 Playwright tests, 11 journeys | The compose stack, required in CI |

The behavioural suite is the browser one: it drives the real client against
MySQL, Redis and the Go API, including two booking flows that exercise the slot
claim. The Go unit tests cover the pieces a browser cannot reach.

Three gates are worth calling out:

- **Schema drift** (`/api/health/db`). It answers 503 with `schema: drift` when
  a table the binary expects is missing, so a half-applied migration fails the
  deploy probe rather than the first query under traffic.
- **Token purposes**: each token carries an audience and purpose, and the Go
  tests prove a refresh token or 2FA ticket cannot verify as an access token.
- **The browser suite** covers the flows; the old message-substring status
  derivation is gone with the typed `*AppError`.
- **The realtime contract** is pinned by the Go hub tests on one side and the
  twelve journeys on the other — no cross-language re-parse step survived the
  Node retirement, so the boundary is checked where it is implemented.

The e2e suite runs in the `docker` CI job on every push, after the seed. It is
a required check.

## Deployment

Six CI jobs plus a dispatch-only CD workflow. `compose` validates the compose file first, in
about ten seconds, because a mis-indented key there once made the `docker` job
fail on its first step and left every later step silently unreachable.

CD runs on `workflow_dispatch` behind a GitHub `production` environment. Schema changes are applied with `cmd/migrate` as a separate
step — never ad-hoc DDL — so the same migration files run in CI and in
production.
