# docs/

Reference documentation for MindEase. [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
is the map — processes, layering, the session chain, the high-level shape. These
documents go one level deeper, and each one is written to be checked against the
code.

## Where to start

| Document | What it answers | Read it when |
|---|---|---|
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | How the three processes fit together and why the load-bearing calls went the way they did | First. It is the map everything else hangs off. |
| [`data-model.md`](data-model.md) | What the 28 tables are for, and why the non-obvious ones are shaped the way they are | Before writing any query, migration or export |
| [`security.md`](security.md) | The threat model: what is defended, how, and what is not | Reviewing a change that touches auth, ownership, free text or video |
| [`testing.md`](testing.md) | How to run the three suites and what each one actually covers | Before running anything, and before adding a test |
| [`operations.md`](operations.md) | Local setup, deploys, backups, rotation, rollback, and the cron jobs that are not durable | On call, or standing up a new environment |
| [`glossary.md`](glossary.md) | The domain vocabulary this codebase uses without defining | Reading any of the above cold |
| [`roadmap.md`](roadmap.md) | Where the remaining known limitations are going, and what is deliberately not being built | Deciding what to work on |
| [`adr/`](adr/) | Architecture decision records — context, decision, rejected alternatives, consequences | Before changing anything that was decided on purpose |

## The ADRs

Three so far, numbered from `0001`. `0000` is the template; copy it, do not
improvise a structure.

| | |
|---|---|
| [`0001-realtime-transport`](adr/0001-realtime-transport.md) | A hand-written Go websocket service, not SSE and not a managed broker |
| [`0002-ai-provenance`](adr/0002-ai-provenance.md) | AI provenance is contractual, and crisis triage never leaves the server |
| [`0003-payment-abstraction`](adr/0003-payment-abstraction.md) | A payment abstraction with a simulator, and the race we left in it |

An ADR records a decision and the alternatives that lost. If you find yourself
writing an ADR to justify something you have already built and shipped, it is
too late — write it, but mark the status honestly rather than implying it was
considered in advance.

## What is not here

- **A privacy policy or terms of service.** This is a portfolio project with no
  operating entity behind it; a document claiming one would be fiction.
- **API reference.** `GET /api/docs` is generated from the same Zod schemas the
  routes validate with, and `server/tests/openapi.test.ts` fails if the two
  drift. It documents existence and request shape, not response shape.
- **Anything the code does not do.** Every claim here is verifiable in the
  repository. Where something is uncertain or unwired, the document says so
  rather than describing an intention — see the "not built" sections of
  [`roadmap.md`](roadmap.md) and
  [`../README.md`](../README.md#known-limitations).

## A note on numbers

Several documents quote counts — tables, test files, tests, models. If a number
disagrees with the repository, the repository is right and the document is
wrong; that is a bug to fix, not a discrepancy to reconcile. The counts were
taken from `schema.prisma`, `npx vitest list`, `go test -list` and the workflow
files rather than from prose.