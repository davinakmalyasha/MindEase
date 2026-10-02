# Self-hosted fonts

Downloaded from Google Fonts by `scripts/fetch-fonts.js` and committed here so
that `next build` never depends on reaching `fonts.googleapis.com`.

`next/font/google` fetches at build time. That made the build fail on a
transient network error - once in CI, and once locally - with
`Failed to fetch Geist from Google Fonts` and
`Can't resolve '@vercel/turbopack-next/internal/font/google/font'`, which
reads like a broken dependency rather than a flaky network.

| File | Family | Licence |
|---|---|---|
| `Geist-Variable.woff2` | Geist | SIL Open Font License 1.1 |
| `GeistMono-Variable.woff2` | Geist Mono | SIL Open Font License 1.1 |
| `PlusJakartaSans-Variable.woff2` | Plus Jakarta Sans | SIL Open Font License 1.1 |

All three are variable fonts covering the full weight range the layout uses.

To upgrade: change the ranges in `scripts/fetch-fonts.js`, re-run it, and
commit the new files.