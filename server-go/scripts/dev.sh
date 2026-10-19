#!/bin/sh
# Boot the API for local development and the Playwright webServer.
#
# Loads the Node server's .env so both implementations share the signing
# secrets during the transition - the web middleware verifies tokens with the
# same JWT_SECRET, and a mismatch reads as "logged out" rather than an error.
if [ -f ../server/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ../server/.env
  set +a
fi
exec go run ./cmd/api
