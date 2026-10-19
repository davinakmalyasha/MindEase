package server

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// openAPIPublicRoutes is the set of method+path pairs reachable without a
// session. Authorization itself lives in handler middleware, so this list is
// the documentation counterpart of those decisions; anything not named here is
// described as requiring the session cookie or a bearer token.
var openAPIPublicRoutes = map[string]bool{
	"GET /health":                            true,
	"GET /health/db":                         true,
	"GET /csrf-token":                        true,
	"GET /openapi.json":                      true,
	"POST /auth/register":                    true,
	"POST /auth/login":                       true,
	"POST /auth/google":                      true,
	"POST /auth/refresh":                     true,
	"POST /auth/logout":                      true,
	"GET /doctors":                           true,
	"GET /doctors/specialties":               true,
	"GET /doctors/slots/{id}":                true,
	"GET /doctors/{id}":                      true,
	"GET /doctors/{id}/packages":             true,
	"GET /reviews/doctor/{doctorId}":         true,
	"GET /reviews/doctor/{doctorId}/summary": true,
	"POST /payments/notification":            true, // provider signature, not a session
	"POST /internal/jobs/{name}":             true, // shared JOBS_SECRET, not a session
}

// buildOpenAPIDocument derives the path list from the live chi route table.
// It deliberately does not invent request schemas: the handlers validate via
// their own parsing, and a hand-written schema that drifts from them would be
// worse than an honest endpoint inventory. Request contracts are pinned by the
// Playwright journeys against the same client.
func (s *Server) buildOpenAPIDocument(api chi.Router) map[string]any {
	paths := map[string]any{}
	_ = chi.Walk(api, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if route == "" {
			route = "/"
		}
		item, ok := paths[route].(map[string]any)
		if !ok {
			item = map[string]any{}
			paths[route] = item
		}
		method = strings.ToLower(method)
		operation := map[string]any{
			"summary": method + " " + route,
			"tags":    []string{firstPathSegment(route)},
			"responses": map[string]any{
				"200": map[string]any{"description": "Success"},
				"400": map[string]any{"description": "Validation or business error", "content": errorContent()},
				"401": map[string]any{"description": "Unauthorized"},
				"403": map[string]any{"description": "Forbidden"},
				"404": map[string]any{"description": "Not found"},
				"409": map[string]any{"description": "Conflict"},
				"500": map[string]any{"description": "Internal error", "content": errorContent()},
			},
		}
		if !openAPIPublicRoutes[strings.ToUpper(method)+" "+route] {
			operation["security"] = []map[string][]string{
				{"cookieAuth": {}},
				{"bearerAuth": {}},
			}
		}
		item[method] = operation
		return nil
	})

	return map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":   "MindEase API",
			"version": "0.3.0",
			"description": "Generated from the mounted chi route table, so every served route is listed. " +
				"Request and response bodies are validated in the handlers and exercised by the browser suite; " +
				"they are not restated here as schemas yet.",
		},
		"servers": []map[string]any{{"url": "/api"}},
		"paths":   paths,
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"cookieAuth": map[string]any{
					"type": "apiKey", "in": "cookie", "name": "accessToken",
				},
				"bearerAuth": map[string]any{
					"type": "http", "scheme": "bearer", "bearerFormat": "JWT",
				},
			},
			"schemas": map[string]any{
				"Error": map[string]any{
					"type":     "object",
					"required": []string{"status", "message"},
					"properties": map[string]any{
						"status":  map[string]any{"type": "string", "example": "error"},
						"message": map[string]any{"type": "string"},
					},
				},
			},
		},
	}
}

func firstPathSegment(route string) string {
	trimmed := strings.TrimPrefix(route, "/")
	if index := strings.IndexByte(trimmed, '/'); index >= 0 {
		return trimmed[:index]
	}
	if trimmed == "" {
		return "root"
	}
	return trimmed
}

func errorContent() map[string]any {
	return map[string]any{
		"application/json": map[string]any{
			"schema": map[string]any{"$ref": "#/components/schemas/Error"},
		},
	}
}
