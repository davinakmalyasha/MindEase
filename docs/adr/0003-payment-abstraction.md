# ADR-0003: A payment abstraction with a simulator, and the race we left in it

- Status: accepted
- Date: 2026-09

## Context

Therapy packages are sold in blocks of sessions. A patient buys three sessions up
front and draws them down one per booking.

Selling therapy means handling money, which for a platform in this category means
the code is a real target and the failure mode is handing out clinical
appointments for free. That shapes everything below: what must be true before an
entitlement is granted, and what happens when a request arrives twice.

## Decision

`PAYMENT_PROVIDER` selects an implementation behind one interface. Two exist:
`midtrans` and `simulator`.

**The simulator is not a test fixture.** It is a first-class mode so that a fresh
clone runs the whole product without anyone signing up for a merchant account.
Without it, the payment path is the one part of the product nobody can exercise
locally, which is how payment bugs get shipped.

## The invariant: `paidAt`

An entitlement is legitimate if it has a verified `paidAt`, **or** an explicit
`grantedByUserId` from an administrator. Nothing else grants sessions.

One column carries the entire security model of the payment subsystem, and it is
worth being explicit about why it is a single column rather than a state machine:
the thing that must not be forgeable is the provider's own confirmation, so the
check is "did a verified callback write this", not "is this row in a state I
expect". A state machine invites a bug where a transition is reachable directly;
`paidAt` has no such path.

The type name is `simulated: boolean` on the order, so it is always possible to
tell afterwards which entitlements were granted without money.

## Simulator is refused in production unless opted into

`env.ts` refuses to start with the simulator in production unless
`ALLOW_PAYMENT_SIMULATOR=true` is set explicitly. `.env.example` says in terms:
do not set this on a real deployment, it hands out free entitlements.

An unrecognised `PAYMENT_PROVIDER` is a **boot error**, not a fallback. This is
the bug that motivated the validation: the provider used to be a type assertion,
and `getPaymentProvider` resolved anything that was not `midtrans` to the
simulator. So `PAYMENT_PROVIDER=midtranss` — one typo — booted cleanly in
production and silently handed out free therapy sessions. A missing merchant
account should stop the process; a misspelt one absolutely should not be
interpreted as consent to the simulator.

## Price is snapshotted, not joined

`PackagePurchase` carries `totalPrice` and `sessionCount` as snapshots, and
`PaymentOrder` holds the `orderId` → purchase mapping.

A clinician can re-price a package at any time. Without a snapshot, re-pricing
silently changes what an existing customer paid and how many sessions they are
owed — and a callback's amount can no longer be re-checked against what was
ordered, so a tampered amount is undetectable.

`PaymentOrder` exists because the provider is told an `orderId` before the patient
is redirected and the same id comes back on the callback. Overloading a purchase
column would make the callback a scan; a separate table makes it one indexed
lookup and leaves room for status transitions later.

## The race we knowingly left in

**Checkout is read-before-create. Two concurrent checkouts for the same package
create two orders, and a callback that lands for both grants twice.**

This is a real defect and it is documented rather than fixed, because the fix is
a design change with a user-facing decision attached and it did not belong in the
same change as the rest of the payment work.

The options, in the order we would take them:

1. **A unique constraint on `(userId, packageId)` for in-flight orders**, then
   convert to a plain index once settled. Correct and cheap, but it means a
   patient who genuinely wants to buy the same package twice cannot until the
   first order settles. That is arguably right — buying three sessions twice by
   accident is a real support burden — and it is a product decision, not an
   engineering one.
2. **Idempotency keys from the client**, which is the standard answer and
   requires the web client to generate and persist one. More moving parts.
3. **A transaction with `SELECT ... FOR UPDATE` on the package row.** Correct and
   the most contention, for a case that is rare.

What makes it survivable today: the callback is idempotent per `orderId`, and
`paidAt` is set once. So a double-submit of the *same* order is handled. The
unhandled case is genuinely two distinct orders.

Flagged in the README's known-limitations section rather than left to be
discovered.

## The webhook

`POST /api/payments/notification` is the only route exempt from both session
authentication and CSRF, because a provider callback cannot present either. It
authenticates by provider signature instead and re-checks the amount against the
stored order before granting anything.

This exemption is as narrow as it can be and is the reason it is documented
rather than left implicit: a webhook that grants clinical entitlements with no
authentication at all would be indefensible, and one that required a cookie would
simply never fire.

## What we did not build

**A real Midtrans integration is not wired.** The provider interface and
configuration are there; `getPaymentProvider` returns a stub. This ADR documents
the shape and the invariants, not a working gateway, and the README says so.

**No refunds, no partial refunds, no proration.** A therapist who leaves after a
patient has paid for five sessions is a real operational problem, and it needs a
product answer about what happens to the money, not just a Stripe-shaped API.

**No tax, no invoicing, no currency conversion.** Prices are integer IDR.

**No subscription model.** Prepaid blocks only.
