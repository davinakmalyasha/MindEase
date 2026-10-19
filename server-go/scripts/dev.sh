#!/bin/sh
# Boot the API for local development and the Playwright webServer.
#
# Loads the repository's .env so the API and the web client share the signing
# secrets - the edge proxy verifies tokens with the same JWT_SECRET, and a
# mismatch reads as "logged out" rather than an error.
if [ -f ../.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ../.env
  set +a
fi
exec go run ./cmd/api
