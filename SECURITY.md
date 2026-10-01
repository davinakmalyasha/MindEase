# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

This project handles mental-health data: screening scores, disclosures of
thoughts of self-harm, free-text journal entries, and consultation notes. A
public issue is the wrong place to describe how to obtain any of that.

Use GitHub's private reporting instead:

**Security → Report a vulnerability** on
<https://github.com/davinakmalyasha/MindEase/security/advisories/new>

Please include the affected file or route, what an attacker gains, and a
reproduction if you have one. You do not need to write a proof of concept.

What happens next: acknowledged within 72 hours, an assessment within a week,
and a fix or a mitigation plan before disclosure. Credit is yours unless you
would rather it were not.

There is currently no formal support SLA, because this is one person's project.
If a report shows a real risk to user data, that is the exception and it gets
answered first.

## What is deliberately in scope

Most of the security work in this repository is documented where it lives, in a
comment explaining the threat and the decision. The load-bearing ones:

| Area | Where to look |
|---|---|
| Session model — httpOnly cookies, CSRF double-submit, JWT purpose separation | `server/src/lib/tokens.ts`, `server/src/middleware/csrf.middleware.ts` |
| Password hashing (argon2id) and account lockout | `server/src/services/auth.service.ts` |
| Two-factor, TOTP replay guard, backup codes | `server/src/services/twoFactor.service.ts` |
| Ownership checks on every clinical record | `server/src/services/carePlan.service.ts` (`assertMayContribute`) |
| The disclosure triage queue, and who may read it | `server/src/services/riskQueue.service.ts` |
| Free-text sanitisation at every write path | `server/src/utils/sanitize.ts` |
| Video session credentials — scoped, short-lived, participant-bound | `server/src/services/video.service.ts` |
| Prompt-injection fencing for every AI call | `server/src/services/ai.service.ts` |
| Error responses, and why they never carry internals | `server/src/utils/appError.ts` |

Three of those are worth calling out because they exist specifically to make a
*clinical* failure visible rather than quiet:

- **`RiskQueueService.listQueue` scopes the triage queue in the SQL `where`
  clause**, so an alert a clinician may not see is never loaded into the process
  at all. A filter applied after the fetch would leak the existence of a
  disclosure to anyone who could not read it.
- **`AiResult` carries `source` and `degradedReason` as type-level fields.** A
  degraded AI response cannot be rendered as if it were a real one without
  ignoring the type, which is the point.
- **`crisisText.service.ts` never auto-escalates.** Matching a crisis phrase
  prompts a human; it does not contact anyone. There is no code path from a
  patient's message to an external service.

## Known gaps

Stated plainly, because a security policy that implies completeness is not a
useful one. These are tracked in the README's known-limitations section with
more detail:

- **Idempotency keys are checked, not scoped.** Replay is bound to the user, so a
  key cannot be reused across accounts, but the same key with a different body
  returns the first result rather than a conflict.
- **No dependency scanning or SAST in CI.** The history has been audited and no
  secret was ever committed, but there is no automated mechanism keeping it that
  way.
- **Sessions are cookie-based with no device list.** "Sign out everywhere" is not
  implemented; a token is valid until it expires or the password changes.
- **Rate limits fail open when Redis is unavailable.** Deliberate — an
  unavailable cache must not take the site down — and the credential limiters log
  a warning on every miss, but it is a fail-open.
- **AI prompts are fenced, not sandboxed.** A per-process random nonce defeats
  delimiter injection; it is not a guarantee against a model reasoning its way
  past a fence.
- **Video falls back to a public third-party room** when LiveKit is not
  configured, and that fallback has no authentication at all. The API reports it
  on every join as `degraded` and the client shows it on screen, but an operator
  who does not configure LiveKit is running unauthenticated video and has to
  notice the warning.

## Deployment notes for operators

- `JWT_SECRET` must be **byte-identical** across the API, the realtime service
  and the web middleware. Changing it invalidates every session. It must also
  differ from `REFRESH_SECRET`, and both must be at least 16 characters and not
  be a known-weak value — the API refuses to boot otherwise.
- Configure S3 before running more than one replica. Without it, uploads go to
  the container's local disk, and an avatar uploaded to one instance is a 404 on
  the next.
- `PAYMENT_PROVIDER` and `VIDEO_PROVIDER` are validated at boot. A misspelling
  is a startup failure, not a silent downgrade — that is deliberate, and the
  validators were added after both shipped as bare type casts.
