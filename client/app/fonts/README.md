# Self-hosted fonts

Downloaded from Google Fonts by `scripts/fetch-fonts.js` and committed here so
that `next build` never depends on reaching `fonts.googleapis.com`.

`next/font/google` fetches at build time. That made the build fail on a
transient network error - once in CI, and once locally - with
`Failed to fetch Geist from Google Fonts` and
`Can't resolve '@vercel/turbopack-next/internal/font/google/font'`, which
reads like a broken dependency rather than a flaky network.

| File | Family | Licence | Axis |
|---|---|---|---|
| `PlusJakartaSans-Variable.woff2` | Plus Jakarta Sans | SIL Open Font License 1.1 | `wght` 200-800 |

One file, because it is a variable font and covers the full weight range the
layout uses.

## Why only one

Geist Sans and Geist Mono were committed here too, and `app/layout.tsx` declared
both with `next/font/local`, each registering a `--font-geist-*` CSS variable.
Nothing ever applied those variables - the `<body>` carried only `jakarta`'s - so
both files were downloaded, hashed, served and preloaded on every page load and
then rendered by nothing. 52 KB of dead weight and two CSS variables that any
later stylesheet could have started depending on without knowing the font was
never referenced.

They were deleted rather than wired up. Adding a typeface to a design is a
decision; removing one nothing uses is not.

## Upgrading

    node scripts/fetch-fonts.js

That rewrites `PlusJakartaSans-Variable.woff2` in place and prints the old and
new sizes. It uses Google's CSS API with a modern-browser `User-Agent`, because
Google serves `woff2` to browsers and older-format subsets to anything it
recognises as a script - which is how you end up with a file named `.woff2` that
is not one.

Check the result in `git diff --stat`: the file should change, and the build
should still pass. If the script cannot reach the network it exits non-zero
without writing anything, so a failed upgrade never leaves a truncated font
behind.