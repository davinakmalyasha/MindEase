# MindEase — one command for the things you actually do.
#
# The alternative was eleven commands across three terminals with two unstated
# prerequisites and two unstated environment files, which is the state this
# replaces. `make help` lists everything.
#
# Deliberately a Makefile rather than a root package.json: there is no JavaScript
# at the root, adding npm workspaces for a three-service repo that shares no
# runtime would be ceremony, and `make` is already how the Go half of this project
# thinks.
#
# Requires GNU make and a POSIX shell (`make doctor` says whether you have them).
# Every recipe runs under /bin/bash, so on Windows that means Git Bash or WSL.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

SERVER := server
CLIENT := client
REALTIME := server-realtime

# --- database credentials -----------------------------------------------------
#
# These have to agree with `docker-compose.yml`, which is where the compose stack
# reads them from. They are declared in one place so that a developer who changes
# the compose password changes it here too, instead of discovering at `make test`
# that the Makefile still believes in the default.
#
# A natively installed MySQL with a passwordless root (the common local setup)
# works with `make test DB_PASSWORD=` — see `make help` and docs/operations.md.
DB_USER ?= root
DB_PASSWORD ?= mindease_secure_root
DB_HOST ?= 127.0.0.1:3306
TEST_DB_NAME ?= mindease_test
DEV_DB_NAME ?= mindease_db

# Every target that touches the database goes through one of these, so the test
# schema and the dev schema can never be confused by a copy-paste.
TEST_DB_URL ?= mysql://$(DB_USER):$(DB_PASSWORD)@$(DB_HOST)/$(TEST_DB_NAME)
DEV_DB_URL  ?= mysql://$(DB_USER):$(DB_PASSWORD)@$(DB_HOST)/$(DEV_DB_NAME)
COMPOSE_DB_URL ?= $(DEV_DB_URL)

# Deliberately NOT exported. `dotenv.config()` does not overwrite an existing
# process.env value, so exporting DATABASE_URL here silently beat whatever the
# developer had put in server/.env — a correct DATABASE_URL was ignored and the
# Makefile's value won. Each target below passes the URL explicitly instead, so
# the file you edited is the file that is used.
export TEST_DATABASE_URL

# `db push` is for the test database only. It is never used against anything you
# care about - see the README's known-limitations section for what that divergence
# once hid.

# NO_COLOR is honoured so `make help` is readable in a Windows cmd.exe terminal,
# which does not interpret ANSI escapes.
ifneq ($(NO_COLOR),)
  C_RESET :=
  C_CYAN  :=
  C_DIM   :=
else
  C_RESET := \033[0m
  C_CYAN  := \033[36m
  C_DIM   := \033[2m
endif

.PHONY: help
help: ## Show this help
	@echo "MindEase"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  $(C_CYAN)%-18s$(C_RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "  $(C_DIM)Docs: README.md, docs/README.md, CONTRIBUTING.md$(C_RESET)"
	@echo "  $(C_DIM)Run 'make doctor' first if anything below fails oddly.$(C_RESET)"

# ------------------------------------------------------------------ doctor ----

.PHONY: doctor
doctor: ## Report whether this machine has everything the other targets need
	@echo "MindEase — environment check"
	@echo ""
	@printf "  %-22s" "make"; make --version >/dev/null 2>&1 && echo "ok" || echo "MISSING (GNU make)"
	@printf "  %-22s" "bash"; bash --version >/dev/null 2>&1 && echo "ok" || echo "MISSING (Git Bash or WSL on Windows)"
	@printf "  %-22s" "node"; \
	  if command -v node >/dev/null 2>&1; then \
	    v=$$(node -v | sed 's/^v//'); \
	    case "$$v" in 22.*|24.*|26.*) echo "$$v (ok)";; *) echo "$$v (repo targets 22.x; see .nvmrc)";; esac; \
	  else echo "MISSING (22 or newer)"; fi
	@printf "  %-22s" "go"; command -v go >/dev/null 2>&1 && echo "$$(go version | awk '{print $$3}')" || echo "MISSING (1.26)"
	@printf "  %-22s" "docker"; command -v docker >/dev/null 2>&1 && echo "ok" || echo "MISSING (only needed for 'make up' and 'make e2e')"
	@printf "  %-22s" "mysql"; \
	  if command -v mysql >/dev/null 2>&1; then echo "client present"; \
	  elif (exec 3<>/dev/tcp/$(DB_HOST)) 2>/dev/null; then echo "reachable at $(DB_HOST)"; \
	  else echo "unreachable at $(DB_HOST) — 'make db' or start your own"; fi
	@echo ""
	@echo "  DATABASE_URL for the test suite:"
	@echo "    $(TEST_DB_URL)"
	@echo ""
	@echo "  If that URL is wrong, override it rather than editing this file:"
	@echo "    make test DB_PASSWORD=          # passwordless local root"
	@echo "    make test TEST_DB_URL=mysql://..."

# ------------------------------------------------------------------- setup ----

.PHONY: install
install: ## Install dependencies for both Node services
	cd $(SERVER) && npm ci
	cd $(CLIENT) && npm ci
	cd $(REALTIME) && go mod download

.PHONY: env
env: ## Create .env files from the examples, if they do not exist
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")
	@test -f $(SERVER)/.env || echo "NOTE: the server reads the root .env; server/.env is only needed to override it"
	@test -f $(CLIENT)/.env.local || echo "NOTE: copy the NEXT_PUBLIC_* block from .env.example into $(CLIENT)/.env.local"

.PHONY: setup
setup: install env ## Install dependencies and create env files
	@$(MAKE) --no-print-directory doctor

# ------------------------------------------------------------------- gates ----

.PHONY: typecheck
typecheck: ## Typecheck the server and the client
	cd $(SERVER) && npm run typecheck
	cd $(CLIENT) && npx tsc --noEmit

.PHONY: lint
lint: ## Lint the server and the client
	cd $(SERVER) && npm run lint
	cd $(CLIENT) && npm run lint

.PHONY: lint-go
lint-go: ## Lint the realtime service (golangci-lint, as CI runs it)
	@if command -v golangci-lint >/dev/null 2>&1; then \
	  cd $(REALTIME) && golangci-lint run ./...; \
	else \
	  echo "golangci-lint is not installed; running 'go vet' only."; \
	  echo "CI pins golangci-lint 2.14.0 and runs it as a required check:"; \
	  echo "  go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0"; \
	  $(MAKE) --no-print-directory vet; \
	fi

.PHONY: vet
vet: ## go vet the realtime service
	cd $(REALTIME) && go vet ./...

.PHONY: check-encoding
check-encoding: ## Repo-wide mojibake guard. Required in CI.
	node scripts/check-encoding.js

.PHONY: check-migration-case
check-migration-case: ## Fail on a migration whose table casing breaks on Linux. Required in CI.
	cd $(SERVER) && node scripts/check-migration-case.js

.PHONY: check-numbers
check-numbers: ## Fail if a documented count disagrees with the repository
	node scripts/check-numbers.js

.PHONY: check
check: typecheck lint lint-go check-encoding check-migration-case ## Every static gate, no database needed

.PHONY: build
build: ## Production-build the client
	cd $(CLIENT) && npm run build

# ------------------------------------------------------------------- tests ----

.PHONY: test-db
test-db: ## Sync the test schema. Uses `db push`; test database only.
	cd $(SERVER) && DATABASE_URL=$(TEST_DB_URL) npx prisma db push --skip-generate

.PHONY: migrate
migrate: ## Build the schema from the committed migrations. The real path.
	cd $(SERVER) && DATABASE_URL=$(TEST_DB_URL) npx prisma migrate deploy

.PHONY: test
test: migrate ## Run the server suite against a freshly migrated database
	cd $(SERVER) && DATABASE_URL=$(TEST_DB_URL) TEST_DATABASE_URL=$(TEST_DB_URL) npm test

.PHONY: test-client
test-client: ## Run the client unit tests
	cd $(CLIENT) && npm test

.PHONY: test-go
test-go: ## Run the realtime tests with the race detector
	cd $(REALTIME) && go test -race -cover ./...

.PHONY: test-all
test-all: test test-client test-go ## Everything that does not need Docker

.PHONY: drift
drift: ## Fail if the database and the datamodel disagree
	cd $(SERVER) && npx prisma migrate diff --from-url $(TEST_DB_URL) --to-schema-datamodel prisma/schema.prisma --exit-code

# --------------------------------------------------------------------- dev ----

.PHONY: db
db: ## Bring up MySQL and Redis alone
	docker compose up -d mysql redis

.PHONY: dev-db
dev-db: ## Apply migrations and seed the development database
	cd $(SERVER) && DATABASE_URL=$(DEV_DB_URL) npx prisma migrate deploy && DATABASE_URL=$(DEV_DB_URL) npm run db:seed

.PHONY: dev-api
dev-api: ## Run the API with reload
	cd $(SERVER) && npm run dev

.PHONY: dev-realtime
dev-realtime: ## Run the realtime service
	cd $(REALTIME) && go run .

.PHONY: dev-web
dev-web: ## Run the web client
	cd $(CLIENT) && npm run dev

.PHONY: dev
dev: ## API, realtime and web together, in three panes. Ctrl-C stops all.
	@echo "Requires MySQL and Redis. If they are not running: make db"
	@trap 'kill 0' EXIT INT TERM; \
	$(MAKE) dev-api & \
	$(MAKE) dev-realtime & \
	$(MAKE) dev-web & \
	wait

# ------------------------------------------------------------------ docker ----

.PHONY: up
up: ## Build and boot the whole stack, then seed it
	docker compose build
	docker compose up -d --wait
	$(MAKE) docker-seed
	@echo ""
	@echo "  web        http://localhost:3000"
	@echo "  api        http://localhost:5000/api/health"
	@echo "  realtime   http://localhost:8080/health"
	@echo "  api schema http://localhost:5000/api/openapi.json"

.PHONY: docker-seed
docker-seed: ## Seed the compose database
	@# From the host, not `docker compose exec`. The production image installs
	@# `--omit=dev` and copies only `scripts/start.sh`, so `ts-node` and
	@# `scripts/seed.ts` are not in it - an in-container seed cannot work. This is
	@# also what `ci.yml` does, so the demo data is identical either way.
	cd $(SERVER) && DATABASE_URL=$(COMPOSE_DB_URL) npm run db:seed
	@echo ""
	@echo "Seeded. Demo accounts are in the README."

.PHONY: down
down: ## Stop the stack
	docker compose down

.PHONY: clean
clean: ## Stop the stack and delete its volumes (asks first)
	@echo "This deletes the MySQL volume and every uploaded avatar. Type 'yes' to continue:"
	@read -r answer && [ "$$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
	docker compose down -v

.PHONY: logs
logs: ## Follow the logs
	docker compose logs -f

# --------------------------------------------------------------------- e2e ----

.PHONY: e2e
e2e: ## Run the Playwright journeys. Needs the stack up and seeded.
	cd $(CLIENT) && npx playwright test

.PHONY: verify
verify: ## The full pre-push gate, in the order CI runs it
	@echo "==> compose config"
	docker compose config -q
	@echo "==> static gates"
	$(MAKE) check
	@echo "==> client build"
	$(MAKE) build
	@echo "==> schema drift"
	$(MAKE) drift
	@echo "==> tests"
	$(MAKE) test-all
	@echo ""
	@echo "Not run here (need Docker or a browser): make up, make e2e"