# ADR-0002: AI provenance is contractual, and crisis triage never leaves the server

- Status: accepted
- Date: 2026-09

## Context

Gemini is used for five things: pre-session questions, doctor briefings, wellness
suggestions, journal summaries, and the support assistant. Each one has a
deterministic local fallback — canned questions, a fixed activity list, a
platform summary in place of a clinical briefing, a help-topic list.

None of it degrades loudly. The SDK times out, the circuit opens, the model
returns something unparseable, and the caller receives a plausible-looking string
in exactly the same shape as real output. A patient reading a wellness suggestion
could not tell whether it was personalised or a template. A clinician reading a
briefing could not tell whether a model synthesised it or the platform filled in
the blanks.

That is a disclosure problem and a safety problem, and it is the kind that only
shows up when it matters.

Separately: patient-to-clinician messages were never inspected for crisis
disclosure. PHQ-9 item 9 produced a signal; anything a patient typed in the thread
produced nothing.

## Decision

Two parts.

**1. Every AI call returns provenance, and it is not optional.**

```ts
interface AiResult<T> {
    data: T;
    source: "model" | "fallback";
    degradedReason?: "not_configured" | "circuit-open" | "timeout" | "error" | "empty" | "malformed";
}
```

`AIService` has no method that returns a bare string. The provenance is threaded
through the service, persisted where it must survive (`PreSessionData.briefingSource`,
because a briefing is re-read days later), and rendered by `AiSourceBadge` as
"Written by AI" versus "Standard guidance — not personalised".

**2. Crisis triage on free text is a regex, deliberately not a model.**

## Why provenance must be a type rather than a convention

Three attempts at the alternative, and why each fails:

**A comment asking callers to include it.** A convention with no enforcement is
one refactor away from gone, and the failure is silent.

**A post-hoc middleware that inspects responses.** Cannot work: by the time a
response is built, the service has already discarded whether the model
answered. Recovering it means either the model runs twice or the flag is threaded
through anyway.

**Logging it.** Logs are not a disclosure. The person who needs to know whether
they are reading a model's synthesis is the person reading it, not whoever greps
Sentry next week.

Making it a return type means the compiler enforces it at every call site, and a
new AI feature that forgets provenance is a type error rather than a silent
regression. The cost is verbosity at every call site, which is the right trade for
a property that is a compliance requirement.

**Why `degradedReason` rather than a boolean.** "It was a fallback" is not
actionable. "The circuit was open" tells an operator the upstream is down;
"not configured" tells them a key is missing; "malformed" says the model
responded and we could not parse it, which is a different bug. Six values is
enough to be useful without being a taxonomy of everything that can go wrong.

## The one deliberate exception

Crisis and escalation replies in the support assistant are **not** labelled as
canned. They are fixed safety instructions carrying emergency numbers, and
marking them as automated would make the one message that must not look
automated look automated. The `ChatMessage.source` field documents that the
`source` flag must not be used to style them as anything but urgent.

This is a considered exception to a rule the rest of the file follows
consistently, which is exactly why it is written down.

## Why crisis triage is not a model

The obvious design is to ask Gemini "is this message a crisis?". Three
properties made the regex the better answer, in order of how much they mattered.

**It never leaves the server.** Sending the most sensitive text a patient can
write to a third-party processor, in order to decide whether to page a clinician,
is a bad trade. We already send mood entries and pre-session answers to Gemini
and disclose it in the privacy policy; this would be a disclosure we would have
to make about the precise moment a patient is in crisis.

**It cannot be unavailable.** A model-based triage has a failure mode that is
unique and terrible: the model times out, or the circuit is open, or the
provider has an incident, and the safety signal is withheld. Every one of those
is a plausible event. A regex has none of them. This is the reason the decision
is not close.

**It is auditable.** A clinician being paged can be told which phrase matched.
"I want to die" matched is reviewable; "a model flagged this" is not, and in a
clinical setting "the model thought so" is close to worthless as a justification.

The cost is recall, and recall is the right thing to give up here because **a
match is never an action**. Nothing auto-escalates to an emergency service. The
alert prompts a human, the queue labels every match as a keyword match rather
than a clinical assessment, and a false positive costs a clinician thirty
seconds. A false negative can cost a life, which is why the design is
deliberately biased toward over-matching rather than trying to be clever.

## What we deliberately did not build

**Negation handling.** "I don't want to die" contains a crisis phrase. Handling
it reliably needs semantics a regex does not have, and the failure would be
silent and in the dangerous direction. Left unhandled on purpose.

**Euphemisms.** "I don't want to be here anymore" is far too common in ordinary
context to page anyone over, and adding it would bury the real signals in noise.

**Third-party reports.** A patient describing a relative is filtered out — not
the patient disclosing, and paging for it trains clinicians to ignore the queue.
A *clinician's* own clinical language is handled by the sender's role, since no
wording filter can do that.

**A confidence score.** The phrase either matches or it does not. A "low
confidence" tier implies a calibration that does not exist here, and would give
clinicians a number to over-trust.

## Circuit breaker

5 consecutive failures, 60-second cooldown, three states. A half-open probe that
fails re-arms the circuit rather than closing it on a single bad sample.

It exists so that requests do not each pay a 20-second timeout against a
dependency already known to be down. With no breaker, one Gemini outage means
every AI-backed endpoint in the product holds a connection for 20 seconds while
it times out.

`__setAIClient` and `__resetAICircuit` are the test seam. Tests substitute a
model double, which is what makes the fallback paths testable at all — and the
fallback paths are the ones that matter most, because they are the ones that run
when something has already gone wrong.
