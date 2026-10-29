# ADR-0005: A clinician copilot that drafts, never decides

- Status: accepted
- Date: 2026-10

## Context

The AI surfaces (`ai.go`, `routes_ai.go`) synthesise briefings, questions,
suggestions and match criteria, each with provenance and a deterministic
fallback. The next useful surface is session preparation: a treating clinician
opening a patient's timeline before a session. The naive version — an agent
with read tools that writes a summary — reintroduces the exact disclosure
problem ADR-0002 solved: a plausible paragraph with no verifiable origin.

Separately, briefings never named what they stood on. A briefing generated
from zero mood entries, zero answers and zero assessments read like one built
from fourteen days of data. The shape gave no way to tell.

## Decision

Two parts, both server-side.

**1. Every synthesis carries its sources and an insufficient-data flag.**

`aiBuildCitations` lists the real rows behind a briefing or draft — mood entry
ids, assessment ids, the appointment behind the pre-session answers — and the
labels state counts and scores, never patient prose. `aiInsufficientData` is
true only when all three inputs are empty, and the client renders that state
instead of a synthesis. An empty input set yields an empty citation list; there
is no branch that invents one.

**2. The copilot drafts prep bullets for the assigned doctor, then forgets.**

`POST /ai/copilot-draft` takes an appointment id, applies the briefing's own
gate (assigned doctor, no pending or cancelled appointments), assembles the
same inputs through the same fenced prompt builder, and returns bullets plus
provenance plus citations. It persists nothing — the only write is the
`clinical.read` audit row naming reader and patient, exactly like a briefing
read. The prompt forbids diagnosis, treatment plans and risk verdicts, and the
fallback is a labeled template with counts, not a synthesis.

## What this is not

Not triage: the copilot never sees the risk queue, never scores, never pages.
Not a care or safety plan: it writes no record the patient or another clinician
reads. Not an agent loop: one prompt, one call, no tools, no retries, no
autonomy. The word "copilot" describes an advisory draft the clinician edits or
ignores, and the audit trail records that a draft was served, not that it was
right.

## Consequences

A draft the model wrote and a template the platform wrote are
indistinguishable without provenance, so provenance stays contractual per
ADR-0002 and the eval harness (`ai_test.go`: citation identity, empty-means-
empty, fallback labeling, fence integrity against a marker-injection answer,
blank-output fallback) pins it. The cost is a second prompt to maintain next
to the briefing's; sharing one prompt would couple a paragraph shape to a
bullet shape, which is how one of them ends up wrong.
