# Support

This is a portfolio project maintained by one person. There is no support SLA,
and pretending otherwise would be worse than saying so.

## What this is

MindEase is a complete, working telehealth platform — built to be studied, run
and improved. It is **not** clinical software. It has not been through the
regulatory process (HIPAA, EU MDR, or local equivalents) that software making
treatment decisions about identifiable people requires, and it must not be used
to make a decision about a real person without independent clinical judgement.

## If you are using it for real care

Please don't, on the strength of a GitHub repository. If you need mental health
support, contact a local crisis line or your national emergency number. The
[`/crisis`](https://github.com/davinakmalyasha/MindEase#) page in the app lists
verified Indonesian and international hotlines; the numbers there are the ones to
use.

## If you want to use it anyway

Read [SECURITY.md](SECURITY.md) first. The short version of what you must handle
yourself, because the project deliberately does not assume it:

- **Encryption at rest.** The database stores screening answers, journal entries
  and disclosures in plaintext. There is no field-level encryption.
- **A BAA / data-processing agreement.** There is no vendor relationship with
  Railway, Vercel, Google (for Gemini) or Fonnte (for WhatsApp). You would be
  responsible for that.
- **S3 or a single replica.** Without S3, uploads land on a container's local
  disk and do not survive a redeploy.
- **LiveKit configured.** Without it, sessions run on a public third-party room
  with no authentication at all. The app says so on screen; it does not prevent
  it.
- **Backup and retention.** `server/scripts/backup.ps1` exists. Nothing runs it
  for you, and there is no retention policy.
- **Notifications are not guaranteed.** The reminder and check-in jobs are
  `node-cron` inside the API process, not a durable queue. A missed run is a
  missed nudge.

## If you found a bug

An issue is the right place. Useful reports include what you did, what happened,
and what you expected — and for anything involving the database, the migration
or the auth middleware, `npm run test:db && npm test` is the fastest way to
confirm it reproduces in a clean environment.

## If you want it to work better

[CONTRIBUTING.md](CONTRIBUTING.md) covers the gates a change has to pass. Those
three checks are the most useful thing in this file to read before opening a pull
request, because they explain a lot of otherwise-inexplicable code.
