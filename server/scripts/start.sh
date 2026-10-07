#!/bin/sh
# MindEase API entrypoint: apply database migrations, then boot the server.
# Used by the production Docker image (Railway, docker compose, etc.).
set -e

echo "[start] Applying database migrations..."
# The binary directly, not `npx prisma`.
#
# `npx` is npm. Calling it here meant the runtime image had to ship npm, and npm
# bundles `brace-expansion` and `undici` - packages with open HIGH advisories
# that no `package.json` in this repository can fix, because npm vendors its own
# copy. The image scan reported them three times across three attempts to
# suppress them, and the only clean resolution is for the package manager not to
# be in the image at all.
#
# The Prisma CLI is installed as a normal dependency, so the binary is already
# on disk at a stable path; `npx` was resolving it at runtime for no benefit.
# Deliberately not `exec`. `exec` replaces this shell, so the Prisma process
# becomes PID 1 and the script never reaches `node dist/index.js` - the container
# migrates, exits 0, and compose restarts it in a loop. Only the final line
# execs.
./node_modules/.bin/prisma migrate deploy

echo "[start] Starting API server..."
exec node dist/index.js
