# MindEase — Agent Conventions

## Infrastructure (MCP tools)
- **Railway** (`railway_*` MCP tools): API, realtime, MySQL, Redis live here. Deployments, services, variables, logs, and rollbacks.
- **Vercel** (`vercel_*` MCP tools): the Next.js web app lives here. Deployments, environment variables, and logs. If the OAuth connection is unavailable, fall back to the `vercel` CLI with `VERCEL_TOKEN`.
- **GitHub** (`github_*` MCP tools): the repo and CI (`ci.yml`) live here. PRs, checks, and Actions.
- **Playwright** (`playwright_*` MCP tools): browser automation for verifying the UI end-to-end before/after deploys.
- **MySQL** (`mysql_*` MCP tools): read/inspect the production database only for diagnosis. Never write to the database unless explicitly asked.

## Deployment rules
- Before mutating anything in production (deploys, env changes, rollbacks, DB writes): state the change and the affected resource, and wait for explicit user approval.
- Apply schema changes with `go run ./cmd/migrate` (the only runner; it baselines a Prisma-built database automatically). Never run ad-hoc DDL against production.
- Check the deploy health endpoint (`/api/health`) after an API deploy.
- After any deployment, verify with a read-back (deployment status / health check) before reporting success.

## Environment & secrets
- Never print, log, or commit secrets. Use `{env:VAR}` interpolation in opencode config; set variables via the platform dashboards (Railway/Vercel) or local env.
- `JWT_SECRET` must be identical across API, realtime, and web middleware — changing it invalidates all sessions.

## Testing gates (before considering work done)
- API: `cd server-go && go vet ./... && go test ./...` (no database needed).
- Realtime: `cd server-realtime && go test ./...`.
- Web: `cd client && npm run lint && npm run build`.
- Schema: `cd server-go && DATABASE_URL=... go run ./cmd/migrate` (baselines an old Prisma database automatically).
