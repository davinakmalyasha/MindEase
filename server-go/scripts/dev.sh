#!/bin/sh
# Boot the API for local development and the Playwright webServer.
#
# Loads the repository's .env so the API and the web client share the signing
# secrets - the edge proxy verifies tokens with the same JWT_SECRET, and a
# mismatch reads as "logged out" rather than an error.
if [ -f ../.env ]; then
  # An explicitly exported PORT wins over .env, so a second replica can run as
  # `PORT=5001 bash scripts/dev.sh` without editing the shared file.
  port_override="${PORT:-}"
  set -a
  # shellcheck disable=SC1091
  . ../.env
  set +a
  if [ -n "$port_override" ]; then
    PORT="$port_override"
    export PORT
  fi
fi
exec go run ./cmd/api
