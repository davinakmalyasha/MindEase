# ADR-0001: A hand-written Go websocket service, not SSE, not a managed broker

- Status: accepted
- Date: 2026-09

## Context

The product needs live updates for three things: chat messages, notification
badges, and — the one that matters — clinical alerts. A clinician paged by an
SOS press or a PHQ-9 item 9 disclosure has to find out while they are still
logged in, not on their next page load.

That last requirement is what shapes everything else. It means the transport has
to push from the server without polling, and it has to survive a reconnect
without a clinician noticing a gap during a session.

The API is Node. Three ways to add push:

1. Server-Sent Events from the existing Express process.
2. A managed realtime broker (Ably, Pusher, Supabase Realtime).
3. A separate Go service sharing Redis pub/sub.

## Decision

A ~200-line Go service (`server-realtime`) that subscribes to one Redis channel
and fans out to browsers over `gorilla/websocket`.

## Why not SSE

SSE is the obvious choice — it is a few lines in Express, no second process, no
new runtime. We rejected it for a specific reason: **SSE has no per-connection
read path in practice.** It is a write-only channel from the server, which is
fine for notifications but means every bit of client→server interaction —
typing indicators, read receipts — needs a separate HTTP round trip. We have
both directions, so SSE would have been half a solution plus a second mechanism
for the other half, and the client would hold two connection lifecycles.

It also does not survive the connection count. One Node process holding a few
thousand long-lived HTTP responses is fine; a few hundred thousand is a different
problem, and it competes with the API for the same event loop and the same
memory ceiling. The realtime traffic is the one thing here that is high-fanout
and low-value-per-byte, which is the classic case for isolating it.

## Why not a managed broker

This is the decision most worth defending, because the managed option is
strictly less work.

Rejected on data residency, not cost. Every message a clinician receives over a
broker leaves our infrastructure and lands in a third party's, including the
contents of private chat and the payload of a risk alert naming a patient who
disclosed thoughts of self-harm. We already send mood entries and pre-session
answers to Gemini deliberately and disclose it; a realtime broker would be a
second processor we would have to disclose, for a feature Redis already
supports. Ably and Pusher also have per-message pricing, which turns a
notification feature into a line item that scales with the number of clinicians.

## What the Go service actually does

Most of the file is `main.go` — Redis URL parsing, fail-fast boot, `/health` —
and the rest is `hub/`. The parts that matter:

**Authenticate before the upgrade.** `ServeWS` used to complete the 101
handshake and validate afterwards, which let an unauthenticated caller hold a
live socket and made a rejected handshake indistinguishable from a normal
disconnect. A client being correctly refused then retried forever, because from
its side that looked exactly like a dropped connection.

**Switch on token purpose.** `hub/auth.go` accepts a `ws-ticket` unconditionally
— the API mints one only after a full session re-check — and an `access` token
only with `TotpVerified` set. Anything else is refused. This is the mechanism
that stops a 7-day refresh token or a not-yet-2FA'd session opening a socket on
a channel carrying private chat.

**Refuse non-HMAC algorithms** in the keyfunc, closing `alg: none` and RS/ES
key confusion before the signature is even checked.

**Caps under one lock.** `Hub.Register` checks per-user and process-wide limits
inside a single `Lock` and registers nothing on rejection. Two concurrent
connects cannot both observe a free slot. The limits are read from env but only
applied if they parse and are positive, so a typo cannot silently disable the
cap.

**Drop rather than block on a slow consumer.** Each client has a 64-event
buffered send channel; publishing is a non-blocking `select` with a `default`
that drops the event. A stalled browser tab must not be able to stall the hub
for everyone else.

**A `/health` that actually probes.** It runs a 2-second `Ping` per request and
returns 503 when Redis is unreachable. It previously answered `ok`
unconditionally, which meant a total realtime outage looked healthy to compose,
Railway and any uptime monitor while every browser sat in a reconnect loop.

**Fail-fast boot on the Redis URL.** go-redis only reports a bad address through
a logger that defaults to a no-op, so a misconfigured `REDIS_URL` produced a
service that stayed up, reported healthy, and silently subscribed to a channel
on a connection that never established. The URL parser exists because
`redis.Options.Addr` wants a bare `host:port` while Node's `createClient` wants a
URL, and passing the URL straight through made the service dial a host literally
named `redis://redis:6379`.

## Consequences

**Accepted costs.** A second language and a second deployable. The contract
between the three implementations of the event union — the TypeScript union, the
Go JSON tags, the client fanout map — is enforced only by
`realtime-contract.test.ts`, which re-parses all three. That test is load-bearing
and its failure would be confusing.

**Dropped events are silent.** A slow client loses messages with no retry and no
queue. For chat that is acceptable because the thread is refetched on load; for a
risk alert it is not, which is why alerts also arrive by in-app notification and
email, and why the queue is polled as well as pushed.

**89% coverage on `hub`, 17% on `main`.** The uncovered part of `main` is
startup wiring. Acceptable, and stated rather than hidden.

## What we would revisit

If a second realtime consumer appeared — a mobile client, a support agent
console — the shared-channel fanout would start needing per-topic subscriptions
and this design would get more complex than a broker. One consumer does not
justify it.
