# MindEase — web client

Next.js 16 (App Router) front end for MindEase. TypeScript, React Query,
Tailwind, next-intl for English and Indonesian.

For the architecture, the design decisions and the known limitations, see the
[repository README](../README.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).
This file is only about running the client.

## Getting started

The API has to be running too — see the repository README for the full stack.

```bash
npm install
cp .env.example .env.local     # or export the variables below
npm run dev                   # http://localhost:3000
```

## Environment

`NEXT_PUBLIC_*` values are **inlined into the browser bundle at build time**.
Declaring them in a container's runtime environment has no effect on an
already-built bundle, which is why they are docker *build args* in
`docker-compose.yml` rather than under `environment:`.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | API base URL, e.g. `http://localhost:5000/api` |
| `NEXT_PUBLIC_REALTIME_URL` | WebSocket URL, e.g. `ws://localhost:8080/ws` |
| `NEXT_PUBLIC_SITE_URL` | Canonical site URL, used for SEO and OG metadata |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google SSO. The button is hidden when unset |
| `NEXT_PUBLIC_SENTRY_DSN` | Client error tracking. No-op when unset |

`JWT_SECRET` is read at **runtime**, not build time, by the edge proxy that
checks session cookies. It must be byte-identical to the API's.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint. 0 errors, warnings only |
| `npm test` | Vitest + jsdom — session, notification store, locale parity, JSON-LD escaping |
| `npx playwright test` | End-to-end journeys. Needs the full stack running |
| `npm run check:deps` | Unused dependency report. Advisory; has false positives |
| `npm run check:encoding` | Repo-wide mojibake guard |

## Layout

```
app/            routes. dashboard/ is the app, the rest is marketing and legal
components/     by domain: ui/ for primitives, the rest by feature
hooks/          React Query hooks, plus useRealtime and useNotifications
lib/            api.ts (the axios instance), format, and domain mappers
messages/       en.json and id.json — key parity is enforced by a test
proxy.ts        session gate for protected route prefixes
```

## Adding a string

Add it to **both** `messages/en.json` and `messages/id.json`.
`tests/locales.test.ts` fails on key drift, empty values, mismatched ICU
placeholders, and English left untranslated.

The one exception is deliberate: crisis hotline numbers and the official names
of the organisations behind them are byte-identical across locales, because a
translated emergency number is a wrong emergency number. They are allowlisted in
that test by path.
