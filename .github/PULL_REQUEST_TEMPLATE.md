# Pull request

<!--
  This template mirrors CONTRIBUTING.md on purpose. If the two disagree, the
  doc is the source of truth and this file is the bug — CONTRIBUTING.md is the
  longer explanation, this is the one you will actually be looking at.
-->

## What changed, and why

<!--
  The subject says what changed; the body says why. Where a comment would
  normally go, put the reasoning here — most of the decisions in this codebase
  have a commit that explains them, and that is deliberate, not a coincidence.
-->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / no behaviour change
- [ ] Docs or tooling only

## Gates

<!--
  These are the three checks in CONTRIBUTING.md, and they are the reason a lot
  of code here looks defensive. Tick the one that applies; if none apply, say
  why in a comment rather than leaving the boxes empty.
-->

- [ ] **Schema drift** — if this touches `prisma/schema.prisma` or adds a migration:

      ```bash
      cd server && npx prisma migrate deploy
      npx prisma migrate diff --from-url "$DATABASE_URL" \
        --to-schema-datamodel ./prisma/schema.prisma --exit-code
      ```

      A column or index that exists only in a migration is drift, and it is
      what dropped `RiskAlert.resolvedById` from the triage queue.

- [ ] **Error status** — if this adds or changes a service that throws:

      ```bash
      cd server && npx vitest run tests/error-status.test.ts
      ```

      Use `badRequest` / `forbidden` / `notFound` / `conflict` from
      `utils/appError`, so the status travels on the type rather than being
      pattern-matched out of a message.

- [ ] **Realtime contract** — if this adds or renames a realtime event:

      ```bash
      cd server && npx vitest run tests/realtime-contract.test.ts
      ```

      One contract, three implementations: the TypeScript union, the Go JSON
      tags, and the client fan-out map. All three are checked by one test.

## Everything else

- [ ] `cd server && npm run typecheck && npm test`
- [ ] `cd client && npm run lint && npm test && npm run build`
- [ ] `cd server-realtime && go vet ./... && go test -race -cover ./...`
- [ ] New user-facing strings exist in **both** `messages/en.json` and
      `messages/id.json`, and pass `client/tests/locales.test.ts`. (The crisis
      hotline numbers are the one allowlisted exception, and they must stay
      byte-identical across locales — a mistranslated emergency number is a
      wrong emergency number.)
- [ ] No new `any` in server code. `npm run lint` is at 76 warnings and 0
      errors, almost all of them `no-explicit-any`; the number should not go up.
- [ ] Comments updated where behaviour changed. A stale comment is the main
      thing a comment costs in this repository.

## Clinical changes

<!--
  Only if this reads or writes patient data, a screening score, a
  disclosure, or anything a clinician acts on. "None of these apply" is a
  valid answer; a silent omission is not.
-->

- [ ] **What would a clinician or a patient actually notice?** Describe the
      observable difference — a different field in the briefing, a row
      appearing in the risk queue, a different label on a screen. "The logic
      changed" is not an answer, and a change nobody can notice has not been
      specified.
- [ ] Nothing auto-escalates. There is no code path from a patient's message
      to an external service, and adding one is a product decision.
- [ ] Model output is advisory. A safety plan is written by a person, and
      `AiResult` carries `source` and `degradedReason` so a degraded response
      cannot be rendered as a real one.
- [ ] Free text rendered to another person goes through `utils/sanitize`
      (`allowedTags: []`).
- [ ] Ownership is checked in the service, not only in the route, so a route
      that forgets a middleware cannot skip the check.

## Risk

<!-- One line. What breaks if this is wrong, and who finds out first. -->

## Notes for the reviewer

<!--
  Open questions, anything you deliberately left out, anything you are unsure
  about. An honest "this part is not tested and I do not know why" is more
  useful here than a clean-looking diff.
-->
