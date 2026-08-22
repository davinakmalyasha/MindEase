#!/bin/sh
# MindEase API entrypoint: apply database migrations, then boot the server.
# Used by the production Docker image (Railway, docker compose, etc.).
set -e

echo "[start] Applying database migrations..."
npx prisma migrate deploy

echo "[start] Starting API server..."
exec node dist/index.js
