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

SHELL := /bin/bash
.DEFAULT_GOAL := help

SERVER := server
CLIENT := client
REALTIME := server-realtime

# Every target that touches the database goes through one URL, so the test
# schema and the dev schema can never be confused by a copy-paste.
TEST_DB_URL ?= mysql://root:@127.0.0.1:3306/mindease_test
DEV_DB_URL  ?= mysql://root:@127.0.0.1:3306/mindease_db

# `db push` is for the test database only. It is never used against anything you
# care about - see the README's known-limitations section for what that divergence
# once hid.
export DATABASE_URL ?= $(DEV_DB_URL)

.PHONY: help
help: ## Show this help
	@echo "MindEase"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[2mDocs: README.md, docs/README.md, CONTRIBUTING.md\033[0m"

# ---------------------------------------------------------------- setup ------

.PHONY: install
install: ## Install dependencies for both Node services
	cd $(SERVER) && npm install
	cd $(CLIENT) && npm install
	cd $(REALTIME) && go mod download

.PHONY: env
env: ## Create .env files from the examples, if they do not exist
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")
	@test -f $(SERVER)/.env || (test -f .env && echo "server reads the root .env" || echo "NOTE: create $(SERVER)/.env — see docs/operations.md")
	@test -f $(CLIENT)/.env.local || (test -f .env.example && echo "NOTE: create $(CLIENT)/.env.local from the NEXT_PUBLIC_* block in .env.example")

.PHONY: setup
setup: install env ## Install dependencies and create env files

# ----------------------------------------------------------------- gates -----

.PHONY: typecheck
typecheck: ## Typecheck the server and the client
	cd $(SERVER) && npm run typecheck
	cd $(CLIENT) && npx tsc --noEmit

.PHONY: lint
lint: ## Lint the server and the client
	cd $(SERVER) && npm run lint
	cd $(CLIENT) && npm run lint

.PHONY: vet
vet: ## go vet the realtime service
	cd $(REALTIME) && go vet ./...

.PHONY: check-encoding
check-encoding: ## Repo-wide mojibake guard. Required in CI.
	node scripts/check-encoding.js

.PHONY: check
check: typecheck lint vet check-encoding ## Every static gate, no database needed

# ----------------------------------------------------------------- tests -----

.PHONY: test-db
test-db: ## Sync the test schema. Uses `db push`; test database only.
	cd $(SERVER) && DATABASE_URL=$(TEST_DB_URL) npx prisma db push --skip-generate

.PHONY: migrate
migrate: ## Build the schema from the committed migrations. The real path.
	cd $(SERVER) && DATABASE_URL=$(TEST_DB_URL) npx prisma migrate deploy

.PHONY: test
test: migrate ## Run the server suite against a freshly migrated database
	cd $(SERVER) && TEST_DATABASE_URL=$(TEST_DB_URL) npm test

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

# ------------------------------------------------------------------- dev -----

.PHONY: db
db: ## Bring up MySQL and Redis alone
	docker compose up -d mysql redis

.PHONY: dev-db
dev-db: ## Apply migrations and seed the development database
	cd $(SERVER) && npx prisma migrate deploy && npm run db:seed

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

# ---------------------------------------------------------------- docker -----

.PHONY: up
up: ## Build and boot the whole stack, then seed it
	docker compose build
	docker compose up -d --wait
	$(MAKE) docker-seed
	@echo ""
	@echo "  web        http://localhost:3000"
	@echo "  api        http://localhost:5000/api/health"
	@echo "  realtime   http://localhost:8080/health"
	@echo "  api docs   http://localhost:5000/api/docs"

# The compose MySQL is published on 3306, so this is reachable from the host.
# Credentials match the default in `docker-compose.yml`; override both together if
# you have set MYSQL_PASSWORD.
COMPOSE_DB_URL ?= mysql://root:mindease_secure_root@127.0.0.1:3306/mindease_db

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
clean: ## Stop the stack and delete its volumes
	docker compose down -v

.PHONY: logs
logs: ## Follow the logs
	docker compose logs -f

# ----------------------------------------------------------------- e2e -------

.PHONY: e2e
e2e: ## Run the Playwright journeys. Needs the stack up and seeded.
	cd $(CLIENT) && npx playwright test

.PHONY: verify
verify: ## The full pre-push gate, in the order CI runs it
	@echo "==> compose config"
	docker compose config -q
	@echo "==> static gates"
	$(MAKE) check
	@echo "==> schema drift"
	$(MAKE) drift
	@echo "==> tests"
	$(MAKE) test-all
	@echo ""
	@echo "Not run here (need Docker or a browser): make up, make e2e"
