# Engineering notes

Written after a hardening pass over this repository, by the person who did the
pass. Not a design document — [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/adr/](docs/adr/) are those. This is the part a document is not supposed to
contain: what was wrong, how it was found, and what I still do not believe.

---

## Two bugs in my own clinical safety path

These are the reason to read the rest of this file. Both were found by reviewing
code rather than by running tests, both survived a suite of 400+ integration
tests, and one of them is the worst bug I have written in this repository.

### A third-party mention silently swallowed a disclosure

`crisisText.service.ts` classified free text for crisis content. Before it looked
for a crisis phrase, it checked a regex for statements about somebody else — and
returned `null` on a match.

> "My husband has been so supportive and I want to die" returned `null`. No alert
> row, no clinician paged, no trace.

The regex matched `my husband`, which appeared before the code ever looked for
`want to die`. The sentence is a textbook first-person disclosure, and arguably a
*more* likely one than a bare statement, because someone who has just described
their support network is reaching out.

The check looked obviously correct. It had a comment explaining why it existed —
a patient describing a relative is not the patient disclosing, and paging a
clinician about it trains them to ignore the queue — and that reasoning is sound.
The implementation just cannot express it, because a regex cannot separate "my
brother attempted suicide" from "my brother is supportive and I want to die".
Both contain a relative and both contain a crisis phrase. Only one is about the
patient.

**Why my tests missed it.** The test suite had `it("does not page anyone about a
disclosure by a third party")`, asserting `null` for two strings. It passed,
because that was the behaviour. There was no test for the overlapping case, because
nobody had imagined it. The fix is a matched pair — one test for the disclosure
that was being swallowed, one for the genuine third-party case that must stay
silent — and the signal is now context for the clinician rather than a suppressor.

### The screening result screen threw away the safety signal

A non-zero answer to PHQ-9 item 9 means the patient has disclosed thoughts of
self-harm. The API does the right thing: it writes a `RiskAlert`, pages the
clinician, and returns `risk: { riskFlag, level, reason, hotlines, crisisPage }` in
the response.

The client spread all of it into `any`, then rendered the score, a severity badge,
and "your result has been saved" — under a green checkmark.

So a patient who had just told a validated questionnaire that they think about
dying was shown a tick, and no hotline. The crisis banner existed 200 lines away
in the SOS button. The capability was there and unwired.

**Why my tests missed it.** The server test suite asserted the alert was written,
the clinician was notified, and the hotlines were in the response — all true. There
was no client test, because client coverage was 2%, and nothing asserted that the
client *read* the field. The response was typed `any`, so the compiler could not
help either. It is now `AssessmentRiskSignal`, and a component that drops the risk
half does not compile.

The interesting part is not the bug. It is that a well-tested API can hand the
right answer to a page that throws it away, and no amount of API testing detects
that. The gap was in the shape of the test, not in the quality of the assertions.

---

## Things that were wrong in ways the comments denied

A pattern worth naming, because it recurred: **several comments described correct
behaviour and the code underneath did something else.** In this repository the
comment was usually right and the code was wrong. That is worth more than it
sounds — a misleading comment costs a reader the ability to check anything, and in
three cases the honest comment was the specification of the fix.

| The comment said | The code did |
|---|---|
| "Switching to pino removed the query string from the logs, which for `/api/admin/users?search=<email>` is PII." | pino-http's default serialiser emits `url` *with* the query. Patient email addresses were being written to the log store. |
| "The realtime counters exist to surface lost clinical alerts." | `criticalTypes` classified `sos:alert` and `risk:alert` as **cosmetic**, and five event types nothing publishes as critical. The counters reported every real drop as routine. |
| "The verified build is the one that ships." | Two `next build` runs; the uploaded one had none of the `NEXT_PUBLIC_*` values and shipped an API client pointing at `localhost`. |
| "This check catches a typographic dash in a code position." | It checked whether any dash survived stripping, which is true of 194 lines of JSX text and doc comments on a clean checkout. |
| "deleting your account purges your journals, mood logs and screening results." | True — and the safety plan and care plan, which hold the patient's own reasons to live, survived against an anonymised account. |
| "GET_LOCK provides a database-backed fallback so the job still runs on single-replica deployments." | `GET_LOCK` is scoped to the *connection*. Prisma pools connections. The lock leaked and the job ran unlocked or not at all, non-deterministically. |
| "Only the placeholder is tracked so the directory exists in a fresh clone." | An unanchored `uploads/` pattern meant the negation below it could never apply. The placeholder had never been tracked. |

None of these were subtle once looked at. All of them were load-bearing.

---

## What the tooling got wrong, which is a different kind of bug

I wrote a script to catch the first bug on that list — a bulk text repair that
replaced JavaScript operators with typographic dashes. It reported 194 findings on
a clean checkout, was wired into CI as advisory, and had never been run by
anything.

I deleted it rather than fixing it, and that decision took longer than the fix
would have. The reasoning: **an em dash in a TypeScript expression is a syntax
error.** `tsc --noEmit` rejects it with `TS1127`. All three historical incidents
were found by the compiler, not by this script. And it cannot be made precise —
in `const x = a — b` and in the JSX text `months — or years`, the dash sits
between two word characters with spaces either side, and only the compiler knows
which one is prose. A rewritten version using the regex the original declared and
never used still reported 74 findings.

So the correct move was to delete a check that duplicated two gates already
required in CI, and to write down why. A permanently red gate trains people to
ignore red, and three advisory guards that cannot fail are worse than none: a
reviewer reads a hundred lines explaining why three checks do not check, and
concludes the guard programme is theatre.

I have since made two more guards that *can* fail, and both were found by writing
them rather than by intending to:

- **`check-numbers.js`** re-derives every count quoted in the documentation. It
  found three drifts the moment it was written, including a Prisma badge reading
  `6.2` against a manifest pinning `6.12`.
- **`check-workflows.js`** found that I had misread my own workflow files. Both of
  its first two false positives were its own: it read `push:` under `on:` as a
  job, and it flagged nine correct `env:` blocks as secrets-in-scripts.

A gate's first output is about the gate.

---

## A 0.7% flake that presented as a database problem

A full suite run failed "opens the room for participants within the window". It
passed in isolation, three times, and the run before it had been green. Nothing in
the failure mentioned two-factor or the database.

The test's helper chose an appointment start of `now + 10 minutes` and clamped only
the *end*. Ten minutes before midnight, `startMinutes` crossed 1440 and the
formatter rendered hour 24 as `"24:03"`. The schema rejects hour 24, so the booking
returned 400 where the test asserted 201.

Ten minutes out of 1440 — 0.7% of runs. It surfaced on the first full run of a
later session purely because that run happened to start at 23:53 Asia/Jakarta.

I initially estimated the rate at 17% and wrote that into the comment before
checking. The correct figure is 0.7%, and the correct figure is the one that
belongs in the repository. I mention it because the instinct to make a bug sound
worse is the same instinct that produces inflated documentation, and this
repository exists partly because it is trying not to do that.

The new test runs the arithmetic 1440 times with the clock injected, because the
live call depended on what time it was when the suite ran — which is exactly why
it went unnoticed.

---

## What I still do not believe

**That the risk queue should be keyword-driven at all.** It works, and the failure
mode is deliberately the cheap one, but the queue's value depends entirely on a
clinician reading it. A page nobody opens is indistinguishable from a page nobody
saw. I cannot measure that from here, so I have said so in
[docs/roadmap.md](docs/roadmap.md) rather than claiming coverage.

**That `node-cron` in the API process is a queue.** It is not, and
[docs/roadmap.md](docs/roadmap.md) says what the right thing is and why it was not
built. The honest summary is that a missed reminder is a missed reminder and I
chose not to add a dependency that would be wrong in a different way.

**That two enum-less tables will survive their first concurrent writer.** 27
models became 28, all statuses are `String`, and the legal values live in
comments. The `JobLock` row I added in this pass is the first place I needed a row
that is only correct if the database enforces something — a unique key. Two
`findFirst`-then-`create` sequences exist in the services that a unique constraint
would close, and I found them by reading rather than by being bitten.

---

## What this pass changed, in one place

Fixes worth naming, because they are the ones I would want a reviewer to look at
first:

- **Disclosure handling.** `THIRD_PARTY` no longer suppresses an alert. SOS and
  risk paths report `recorded` and `alertId` separately from `clinicianNotified`,
  because they fail independently and conflating them is how a disclosure ends up
  with no audit trail while every caller believes it was handled.
- **Data exposure.** Two more places returned every column of `Doctor` to
  authenticated callers, bank details included. The directory leak had been fixed
  and tested; these two were missed because `include: { user: { select } }` looks
  restricted and is not.
- **Configuration.** `.env.example` shipped placeholders that passed every
  production check, so `cp .env.example .env` and a deploy produced an API signing
  every token with a published string. `TWO_FACTOR_SECRET` — the value that mints
  2FA tickets — had a bespoke validator that skipped every strength check the
  other two went through.
- **The deploy path.** The step `AGENTS.md` requires after every deployment
  reported green while printing four `FAILED` lines, because every probe was
  `|| echo "FAILED"` piped into `tee`. Three images shipped with no CVE scanning,
  because the Trivy job was set to report misconfiguration only and its comment
  explained why that was fine.
- **A patient's own crisis document.** The safety-plan draft was re-seeded on
  every refetch, so a window focus erased it; and a failed load rendered an empty
  editable form, where saving sent `""` for all six fields and the service treats
  an empty string as *clear*.
- **A profile could be overwritten with nothing.** The same failure mode as the
  safety plan, on the profile form: a rejected load left every field at `""` and
  rendered the form anyway, so correcting one field and saving blanked all the
  others. Details under "What I would do next", which is where I also correct the
  inflated count I attached to this class of bug.

## How this was verified

Every change in this pass was run against a real MySQL with real Argon2 — the same
posture as the original suite. `make verify` is the local gate; CI runs the same
checks in the same order, plus the drift gate against a database built from the
committed migrations, a weekly schedule, four security scanners, and every GitHub
action pinned to a commit SHA.

The suite is 468 tests across 36 files and takes about six minutes, most of it
Argon2. It runs serially, because the per-test reset is a 28-table wipe and
running files concurrently would let one file's `beforeEach` delete another file's
rows mid-test.

## What I would do next

1. ~~Fix the twenty-odd surfaces that render an empty state when they should
   render an error.~~ **Done, and my count was wrong in a way that mattered.**

   I wrote "twenty-odd" before looking. What was actually there was ten
   components with a `.catch()` and no error state, and several of those are
   correct: an optimistic update that rolls back by refetching is supposed to
   swallow the original error, and a deliberate `.catch(() => null)` probe for
   "does this exist yet" is a different thing entirely. Measuring first would
   have spared me the exaggeration.

   The real defects were worse than a missing message.

   **The profile form could destroy the profile.** `/dashboard/profile` submits
   a `PUT` that writes *every* field. Its fields initialise to `""`, a failed
   load left them there, and the form rendered regardless. So the request fails,
   the user sees a blank profile, they fix their phone number, they save, and
   the server receives `""` for their name, avatar, referral code and
   weekly-report setting. A toast had flashed "Failed to load profile" and
   vanished — true, and not acted upon. The fix is to refuse to render an
   editable form that has not loaded, which is the only safe behaviour for a
   submit that overwrites everything.

   **A doctor's public profile hung forever.** `/doctors/[id]` handled only
   404. For anything else — a 500, a dropped connection — `doctor` stayed
   `null`, `isLoading` went `false`, and the guard `if (isLoading || !doctor)`
   kept rendering an animated skeleton. Indefinitely. Not an error, not an empty
   state, not a spinner that ever finishes. A skeleton with nothing behind it is
   the worst of the three states, because it promises a resolution that never
   arrives.

   **Two 404s were treated as permission to regenerate.** The briefing page
   fetched the cached text and fell through to `generate(true)` on *any*
   rejection. The pre-session page probed for existing questions with
   `.catch(() => null)` and, on `null`, generated fresh ones. In both cases the
   code that was asked whether a record existed never received an answer and
   supplied one. A dropped connection therefore cost an LLM call, and for a
   patient who had already answered their pre-session questions it discarded
   that work. Now only a 404 is evidence of absence; everything else is
   "unknown", and unknown gets a retry rather than a regeneration.

   Six panels fixed. `scripts/check-load-states.js` now fails the build if a
   component swallows a fetch error into a falsy value, if a form can be edited
   before it has loaded, or if absence is claimed with no 404 behind it. Its
   self-test rebuilds the pre-fix dashboard from git and asserts the gate
   rejects it — including the case where the anti-pattern appears only inside a
   comment, which is what happened the first time I pointed it at files that now
   *explain* the fix in prose.

2. ~~Give `TrajectoryChart` a legend and a text alternative.~~ **Done.** The
   severity bands are the entire clinical meaning of that chart and were
   tint-only, so a reader who cannot separate `#fecaca` from `#fdba74` learned
   nothing about where "severe" begins. The bands are now enumerated as a
   labelled list with their numeric ranges, the visual is `aria-hidden` so a
   screen reader does not walk every rect, and an `sr-only` sentence states
   first score, latest score and both severities — the line's slope is the
   reading a clinician takes from this chart, and slope is unavailable to
   anyone who cannot see the line. One axis label also moved from `#9ca3af` to
   `#6b7280`, which is the 285th contrast fix and drops the ratchet to 285.
3. ~~Add the missing `@@index` on `Review.userId`.~~ **This was wrong, and I wrote
   it as though it were right.** `Review.userId` is not unindexed. InnoDB creates
   an index for every foreign key, and this one is called `Review_userId_fkey`:

       PRIMARY                              id
       Review_appointmentId_key             appointmentId
       Review_doctorId_hidden_createdAt_idx doctorId, hidden, createdAt
       Review_userId_fkey                   userId

   So the account-deletion query is indexed, and both responses available to me
   were wrong: add a redundant index, or leave a false performance claim in the
   documentation where the next person would trust it.

   The real defect was that the schema does not say any of this, so it reads as
   an oversight — and there are five such columns across five models, plus six
   more that carry an inline `@unique`. `scripts/check-schema-indexes.js` now
   requires each one to be acknowledged with a reason, so adding a relation forces
   somebody to decide whether it needs an index rather than leaving the question
   open forever.

   Writing that gate also caught me twice: it does not count an inline `@unique`
   as an index, so six acknowledgements were for columns that already had one —
   saying "reviewed and fine" about nothing — and its own stale-entry check tested
   truthiness against values that are empty strings, so it reported all five real
   entries as stale.
4. Move the client off `useEffect` + `fetch` + `useState` onto the `useQuery`
   pattern the rest of the app uses. Fifteen sites, four of them large pages.

   **The migration is not the interesting part, and I nearly led with it.** I
   built a scanner for the ad-hoc pattern and was about to describe the count as
   a defect. It is not: `useQuery` is a house style, and `useEffect` is not a bug.
   So I measured the *consequences* instead — stale writes, missing retry paths,
   cursors that advance on failure — and that produced two real bugs and one
   finding about my own tooling. The rest of the sites are genuinely just
   inconsistent, and `useQuery` would fix them by being nicer, not by being
   correct.

   What it did find:

   **A clinician could read the wrong patient's clinical summary.** Next.js keeps
   `/dashboard/briefing/[appointmentId]` mounted across a navigation from
   appointment A to appointment B, and `params` resolves asynchronously, so both
   requests can be in flight. Nothing stopped A's response from landing last and
   overwriting B — and the briefing *is* the mood history and pre-session
   reflections, which is exactly the sort of summary that must never appear
   beside the wrong name. `useQuery` would have prevented this incidentally, by
   keying the cache on the id. The fix I wrote is explicit: a monotonic sequence
   number, checked after every `await`, and bumped again on unmount so a
   response that settles after teardown declines to write.

   **The pre-session page had the same race, with a worse consequence.** The
   writes sit either side of a generating `POST` that can take seconds, so a
   patient who navigated away mid-generation would have had their new form
   replaced by the previous patient's saved answers — the reflections a clinician
   reads before a therapy session, transposed across two people.

   **One failed "load more" made a page of doctors unreachable.** `/doctors`
   did `await loadPage(page + 1); setPage((p) => p + 1)` with no check, and
   `loadPage` caught its own errors to keep the loaded pages. So a single failed
   request advanced the cursor past results that never arrived, and the next
   click asked for page 3. Permanent, silent, unretryable — the button simply
   did not do anything useful. `loadPage` now returns `Promise<boolean>` so the
   failure is visible in the signature rather than in a comment.

   And the same file reported a failed AI match as an empty list, which rendered
   "No specialists matched your description" — a confident claim about a
   practice's roster, manufactured by a connection failure.

   `scripts/check-stale-writes.js` now fails the build when a `[param]` page has
   no staleness guard, when a fetch chain writes without re-checking it, when a
   cursor advances unconditionally, or when a failure is rendered as an empty
   result. Its self-test strips each mechanism back out of the real files and
   asserts the gate notices. Three of the four checks failed against the fixed
   code before I fixed the checker rather than the code — one of them because my
   regex was counting `params.then()` as a fetch handler.
5. ~~Write the accessibility pass.~~ **Partly done, and my description of it was
   wrong twice.** I wrote "icon-only buttons without labels, form errors that are
   never announced, and 224 uses of a grey that fails contrast at 2.54:1."

   Measured, the first two were much smaller than that and the third was larger:

   | | I said | Measured |
   |---|---|---|
   | buttons with no accessible name | "several" | **2** |
   | field errors never announced | "several" | **12**, in two files |
   | sub-AA text uses | 224 | **286**, across 59 files |

   And the first measurement was wrong in the direction that matters. The
   detector stripped `{...}` groups before looking for text, which removed the
   string inside `{cond ? <Loader2/> : "Verify & Sign In"}` and reported **26**
   buttons. Twenty-four were correctly labelled. A false positive in a detector
   like this gets an `aria-label` bolted onto a button that already has a name,
   which is harmless to a screen reader and ruinous to review — so it is pinned
   by a test case now.

   Then the gate, once written, had the bug in the other direction. It took
   string literals from the whole `{...}` group, so
   `{isLoading ? <Loader2 className="animate-spin" /> : null}` produced the name
   `"animate-spin"` and an icon-only button passed. That is a **false negative on
   exactly the buttons the rule exists to find**, and the two real ones were only
   fixed because I read the markup — which is the thing the gate was supposed to
   stop requiring.

   `scripts/check-a11y.integration.js` now breaks a real button and a real error in
   a real file, checks the gate fails, and restores the file. A rule that has never
   been observed failing is a rule of unknown value.

On contrast: 286 uses of `text-gray-50..400` across 59 files, and `gray-400` on
   white is 2.54:1 against an AA requirement of 4.5:1. Fixing that in one commit
   would be 59 files of visual change nobody could review, so the gate holds a
   **budget that may only shrink** — currently 285, after the `TrajectoryChart`
   axis label moved from `#9ca3af` to `#6b7280`, which is the smallest change
   that actually fixes anything: `gray-500` on white is 4.83:1, so the palette
   already had a passing shade and I had used the failing one anyway. A gate
   demanding zero would have been disabled on its first day.

---

## The CI pass took nine commits, and the sequence is the point

The image scan could not work, and each attempt failed in a way that was
informative. In order:

1. It scanned `mindease-api:ci` — a tag nothing in this repository produced. So
   the build never had that tag.
2. I resolved the reference by asking Compose, with `docker compose images -q`,
   which lists *containers*. A job that only builds has none. Empty reference, and
   Trivy exited non-zero on all three images.
3. I gave every built service an explicit `image:` so the name would be knowable.
   Then the build reported `naming to docker.io/library/mindease-api-ci` —
   because `image: mindease-api-${IMAGE_TAG:-latest}` puts the variable in the
   *repository*, so `mindease-api-ci` is a repository name with an implicit
   `:latest`, not `mindease-api` at tag `ci`. The reference the scan asked for and
   the tag the build produced still did not match, one character apart.
4. With the name finally right, the scan worked and found ten HIGH findings. Ten
   *real* findings — and every one was in `eslint`, a build-time linter that had
   been shipped into the production image, because `npm install --no-save prisma@x`
   re-resolves the tree without `--omit=dev`.
5. Upgrading npm took it to three. The rest are inside npm itself, vendored, and
   unreachable from any `package.json` here. npm 11 and npm 12 bundle the same
   affected versions.
6. So I wrote a suppression file. It took four more commits to become valid: first
   a bare YAML list where Trivy wants a mapping, then `paths` written without a
   leading slash, which matched nothing while the scan kept reporting all three
   findings and nothing in the log said why.
7. And then the actual fix, which had been available the whole time and was not
   about npm's version: `scripts/start.sh` called `npx prisma`, and `npx` is npm.
   The Prisma CLI is an ordinary dependency, so the binary is already on disk. One
   line changed, and both runtime images no longer contain a package manager.
8. Which broke the boot, because I wrote `exec` on the migration line: `exec` makes
   Prisma PID 1, so the script never reached `node dist/index.js` and the container
   migrated, exited 0, and restarted in a loop.

Three things in that list are worth keeping.

**A gate that cannot find its subject fails while reporting nothing.** The scan
looked exactly like a gate passing a red build, three times in a row. The response
people give to that is to delete it, and deleting it would have removed the only
thing that eventually found the `eslint` finding.

**Two diagnostics were worth more than any of the fixes.** `docker compose logs`
on failure turned a CI cycle into one line of reading: the migration step's
`exec` bug was visible immediately. And Trivy's table format does not print the
path of a finding, which is why the suppression file took four commits of guessing
at glob syntax — so the scan now prints `CVE<TAB>path` on failure.

**Suppression was the wrong answer and it cost three commits to prove it.** The
honest version of that sequence is: I could not fix the findings, so I tried to
hide them, and hiding them was harder than the fix. A suppressions file that
silently matches nothing looks identical to one that works, which makes it worse
than having none.

## Triage: what the security review found, and what I did about it

GitHub's Advanced Security check on the pull request reports findings as inline
annotations, which are ordinary review comments — so unlike the code-scanning
alerts, they *are* readable. Thirty-one in total by the end. Four mattered.

**"User-controlled bypass of security check" — `twoFactor.service.ts`.** The
highest severity of the set, and the one worth having.

Enrolling a second factor is a privilege change, and every sibling one —
disabling 2FA, changing a password, deleting an account — requires the password
first. The check was:

```ts
if (existing?.password) {              // ← a security decision on a nullable column
    const confirmed = password && await argon2.verify(existing.password, password);
    if (!confirmed) throw badRequest(...);
}
```

So whether a security control applied depended on the *absence of data* rather
than on how the account authenticates. CodeQL is right to flag the shape. Today
the only code that nulls that column is account deletion, which also sets
`provider: "deleted"` and `isBanned: true`, so the difference is academic — but
"the column happens to be null" is not a statement about authentication, and the
next passwordless provider would have to remember to leave it null.

It now keys off `provider`, and **fails closed**: anything not explicitly
passwordless is confirmed, including a provider this code has never heard of.

**"Incomplete multi-character sanitisation" and "polynomial regular expression" —
`mailer.service.ts`.** Both on one expression, in the development fallback that
prints the email body so a developer can copy the OTP:

```ts
logger.warn({ to, subject }, `[MAIL] ...\n${html.replace(/<[^>]+>/g, "")}`);
```

Three problems, one of which the two others were hiding behind: a regex is not a
sufficient HTML sanitiser (`<!--` survives it, so an HTML comment opener can still
reach a log viewer that renders it); it is flagged as a polynomial expression
over attacker-controlled input; and `to` and `subject` are user-controlled values
written into a log line, which is log injection — a crafted address containing a
newline forges a second entry.

None of that is fixed with a better regular expression. The caller already knows
the code, so it passes it; the log gets the recipient, the subject and the code,
each scrubbed of control characters and truncated.

**And four false positives, which I am not going to "fix".**

`server-realtime/hub/client.go` reports log injection three times on
`log.Printf("user %d …", c.ID, err)`. The taint is real — `c.ID` comes out of a
JWT — and the sink is safe, because `Client.ID` is an `int64` and `%d` on an
integer cannot emit a newline or an escape sequence. Wrapping it in
`strconv.FormatInt` would change nothing and make the code worse. The right
response to a false positive is to say why, not to contort the code into
satisfying the query.

`scripts/check-a11y.js` is flagged for stripping HTML comments with a regex that
does not match `<!-->`. That output is never rendered — it is tested for "does it
contain a letter" and discarded — and a residual `<!--` cannot make an unlabelled
button look labelled. The comment in the file now says so, because the next
person should not have to re-derive it.

**And one gate I wrote failed the same way.** `check-encoding.js` — strengthened
in this pass to catch literal control bytes in source files — immediately caught
me doing exactly that: the escape class I typed into `mailer.service.ts` landed as
raw control bytes. It is the same incident as `message.schema.ts`, which is the
argument for having had the gate before I needed it.

## The check that could not fail

The most useful thing in this pass was a gate that turned out to be decorative.

`scripts/check-auth-coverage.js` walks every route registration and reports the
ones with no authentication middleware. I wrote it after finding that
`GET /api/reviews/doctor/:doctorId` — unauthenticated by design, because reviews
belong on a clinician's public profile — returned `user: { id, name, avatar }`
for every review. An anonymous caller walking `/doctor/1`, `/doctor/2`,
`/doctor/3` collected the real name, avatar and internal user id of every patient
who had reviewed a clinician. That is the identity of someone recorded as having
received mental healthcare from a named person, enumerable without an account.

`GET /doctors/:id` had already been rewritten to an explicit allowlist for
exactly this class of leak. This endpoint was missed because it lives in a
different service, and because the comment above it says *public* — which reads
as reassurance rather than as a warning about what public *means*.

The service now selects only the id and derives a stable pseudonym from it.
Clinician replies stay attached, because a clinician answering a specific
concern publicly is the feature and not a disclosure.

**And then the gate itself was wrong four times**, which is the part worth
recording:

1. It had no `process.exit`. It printed `2 unguarded` to stdout and exited **0**.
   In CI it would have looked like a passing step while reporting failures, and
   would never have stopped a merge. A checker that cannot fail is a comment.
2. It read each registration in isolation, so the twelve admin endpoints behind
   `router.use(authenticate, requireAdmin)` were all reported unguarded.
3. Once that was fixed, it scanned a 14-line window that included the
   `import { authenticate }` line — so every route within a dozen lines of the
   import block passed for free. Deleting `router.use(authenticate)` from
   `wellness.routes.ts` still produced a clean report.
4. Its leak regex was written `select\s*:\{`, which does not match `select: {`.
   It matched nothing, and so reported the *fixed* code as clean.

Every one of those was found by the self-test, which rebuilds the pre-fix code
from git and requires a non-zero exit. Then it found a fifth problem in my own
remediation: the first leak regex was unscoped, so it also matched
`createReview` — which returns the review to the patient who wrote it, where the
name is correct and necessary. A check that flags correct code gets disabled,
and then it protects nothing.

## The check that stays red

After all of that, GitHub's Advanced Security check still fails, and I do not
think it can be made to pass on this pull request.

It reports on the accumulated diff — about 36,000 added lines — and GitHub does
not retract an inline annotation when the finding is fixed. Nine of the thirteen
"unused variable" annotations were stale by the time I looked at them, pointing
at imports I had already deleted. A list that only ever grows is a list a
reviewer learns to skim, which is how the four that mattered ended up buried under
nine that did not.

So the useful question is not "why is it red" but "is anything still red". Both
CodeQL jobs I wrote pass and upload SARIF; the repository has **zero**
code-scanning alerts, confirmed through the API against the commit, the branch
and the PR ref. Every annotation I could read is either fixed or documented above
with a reason.

I would rather say that than describe CI as green.

## A tool that cannot work on the platform its authors use

`pin-actions.js` exists to rewrite unpinned action references to commit SHAs.
It reported:

    3 workflow files
    0 references already pinned to a SHA
    0 references on a mutable tag
    Every action reference is pinned. Nothing to do.

There are thirty references and all thirty are pinned, so "nothing to do" is the
right conclusion — arrived at by a mechanism that had looked at nothing.

Two bugs. The scan `continue`d past pinned references before pushing to a list,
and the summary computed the pinned count as `list.length - unpinned.length`, so
the number was structurally incapable of being non-zero. And it read files with
`split("\n")` against a regex ending in `$`; `.` does not match a carriage
return, so in `security.yml` — which is checked out with CRLF — *every*
reference was invisible.

On a fresh clone of this branch, with one reference unpinned, that script would
have reported "everything is pinned" and changed nothing. It is the most
dangerous shape a maintenance tool can have: it looks like it ran, and it is
believed, and it does nothing. Both are pinned by `pin-actions.test.js` now, and
the reason is in the test names rather than only in the diff.

## The finding I could not see, and what it turned out to be

The high-severity one was `scripts/pin-actions.js`: an outbound request whose
path is assembled from `owner` and `action` read out of workflow files, with only
`ref` escaped.

The obvious fix was to escape all three. The better fix was to stop building
paths from file content at all: validate `owner`, `action` and `ref` against
allowlists before the path is constructed, so the question being answered is "is
this a GitHub API path" rather than "did I escape the parts". `ref` excludes `/`
— a git branch name may contain one, but this only ever resolves tags, so
excluding it means `..` cannot appear and there is nothing to defend against.

And the test suite caught my first version of that allowlist, which permitted
`/` and therefore accepted `v5/../../admin`. The encoding would have made the
request safe, which is exactly why relying on it was the wrong answer.
