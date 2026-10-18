# server-go porting conventions

Short rules for porting a domain from `server/` (Node) to `server-go/` (Go).
The Node implementation is the specification; the database schema and the
client are the judges.

## Layout

- One file per domain: `internal/server/routes_<domain>.go`, package `server`.
- Each file exposes `func (s *Server) register<Domain>(api chi.Router)` and
  registers routes under `/api`-relative paths, e.g. `api.Get("/doctors",
  handler)`.
- Helpers available on `Server`: `Cfg`, `DB`, `Redis`, `Log`, `Sanitizer`.

## Contracts

- Response JSON must match the Node controller exactly: status codes, envelope
  (`{"status":"success","data":...}` vs a bare object vs `{"status":"error",
  "message":...}`), field names, null vs absent, and error messages.
- Several controllers catch service errors and return a fixed status
  (`res.status(400)` on register, `401` on login, `403` on some). Check the
  controller; do not assume the AppError status is what reaches the client.
- The Zod validate middleware returns
  `{"status":"error","message":<first issue>,"errors":[{"path","message"}]}` —
  use `s.validationFail(w, "body.field", msg)` with the Zod message text.
  Mirror the schema's strictness: `.strict()` rejects unknown keys.

## Auth

- `r.With(s.authenticate)` mirrors `authenticate`; add
  `s.RequireRole("doctor")` where the Node route uses `requireRole`.
- `CurrentUser(r)` returns `*UserCtx{ID, Role, Email, Name, DoctorProfileID}`.
- Cookies: access/refresh are set/cleared by `setSessionCookies` /
  `clearSessionCookies`.

## Database

- Table/column names exactly as `prisma/schema.prisma` (backtick-quoted
  identifiers for the MySQL driver).
- Ids: `newID()` (UUIDv7). Never an auto-increment.
- `createdAt` has a DB default; **`updatedAt` does not** (Prisma set it in the
  app). Every INSERT that has the column and every UPDATE must write
  `updatedAt = time.Now().UTC()`.
- Times in JSON: wrap with `jsTimeValue(t)` / `jsTime(&t)` so the shape is
  JavaScript's `Date#toISOString`.
- Never select credential columns into responses; `UserRow.Safe()` is the
  stripped user shape.

## Errors

- `s.Fail(w, status, msg)`, `s.FailExtra(w, status, msg, extra)`.
- Domain errors: `BadRequest/Unauthorized/Forbidden/NotFound/Conflict` — handled
  by `s.AppErr(w, r, err)` when bubbling up, or check and `Fail` directly.
- Unknown errors are logged and become a generic 500 — never leak driver text.

## Limits

- `s.limiter(rateLimitConfig{name, window, max, message, skipSuccessful})` is
  the only limiter constructor. Port each route's limiter from the Node route
  file with the same name, window, max and message. The per-account limiter
  (keyed by email) is applied inside the handler via `s.bump("account", ...)`
  because the middleware cannot read the body.

## Hygiene

- `s.Sanitizer` (bluemonday UGCPolicy) where Node sanitizes free text.
- `go build ./...` and `gofmt -l internal/server` must be clean.
- Do not edit `go.mod`, `server.go`, or another domain's file. Define any new
  helper in your own file with a domain-unique name.
