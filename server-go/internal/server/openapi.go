package server

import (
	"net/http"
	"strconv"
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
	"GET /readyz":                            true,
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
// Response schemas cover the shapes the client reads; request bodies are
// validated in the handlers and exercised by the browser suite rather than
// restated here where they could drift.
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

	doc := map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":   "MindEase API",
			"version": "0.5.0",
			"description": "Generated from the mounted chi route table, so every served route is listed. " +
				"Response schemas cover the client-critical reads and writes; request bodies are validated " +
				"in the handlers and exercised by the browser suite.",
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
			"schemas": openAPIComponentSchemas(),
		},
	}
	attachOpenAPIResponseSchemas(paths)
	return doc
}

func schemaRef(name string) map[string]any {
	return map[string]any{"$ref": "#/components/schemas/" + name}
}

func schemaArray(name string) map[string]any {
	return map[string]any{"type": "array", "items": schemaRef(name)}
}

func envelope(data map[string]any) map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"status": map[string]any{"type": "string", "example": "success"},
			"data":   data,
		},
	}
}

func paginatedRows(item string) map[string]any {
	return envelope(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"rows":       schemaArray(item),
			"total":      map[string]any{"type": "integer"},
			"page":       map[string]any{"type": "integer"},
			"totalPages": map[string]any{"type": "integer"},
		},
	})
}

// attachOpenAPIResponseSchemas binds the schemas to the operations the client
// actually reads. The route walk already listed everything; this adds the
// shapes without pretending that every endpoint has a documented body.
func attachOpenAPIResponseSchemas(paths map[string]any) {
	attach := func(method, route string, status int, schema map[string]any) {
		item, ok := paths[route].(map[string]any)
		if !ok {
			return
		}
		operation, ok := item[strings.ToLower(method)].(map[string]any)
		if !ok {
			return
		}
		responses := operation["responses"].(map[string]any)
		responses[strconv.Itoa(status)] = map[string]any{
			"description": "Success",
			"content":     map[string]any{"application/json": map[string]any{"schema": schema}},
		}
	}

	attach("GET", "/users/profile", 200, envelope(schemaRef("UserProfile")))
	attach("GET", "/doctors", 200, paginatedRows("DoctorSummary"))
	attach("GET", "/doctors/{id}", 200, envelope(schemaRef("DoctorDetail")))
	attach("GET", "/doctors/slots/{id}", 200, envelope(schemaArray("Slot")))
	attach("GET", "/wellness/mood", 200, envelope(schemaArray("MoodEntry")))
	attach("POST", "/wellness/mood", 201, envelope(map[string]any{
		"allOf": []any{schemaRef("MoodEntry")},
		"properties": map[string]any{
			"replaced": map[string]any{"type": "boolean"},
		},
	}))
	attach("GET", "/wellness/journal", 200, envelope(schemaArray("JournalEntry")))
	attach("GET", "/notifications", 200, paginatedRows("Notification"))
	attach("GET", "/appointments/my", 200, paginatedRows("Appointment"))
	attach("GET", "/care-plan", 200, envelope(schemaRef("CarePlan")))
	attach("GET", "/safety-plan", 200, envelope(map[string]any{
		"nullable": true,
		"allOf":    []any{schemaRef("SafetyPlan")},
	}))
	attach("GET", "/reviews/doctor/{doctorId}", 200, map[string]any{
		"type": "object",
		"properties": map[string]any{
			"status": map[string]any{"type": "string"},
			"data":   schemaArray("ReviewPublic"),
			"pagination": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"page":       map[string]any{"type": "integer"},
					"limit":      map[string]any{"type": "integer"},
					"total":      map[string]any{"type": "integer"},
					"totalPages": map[string]any{"type": "integer"},
				},
			},
		},
	})
	attach("GET", "/payments/config", 200, envelope(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"mode":      map[string]any{"type": "string", "enum": []string{"midtrans", "simulator"}},
			"simulated": map[string]any{"type": "boolean"},
		},
	}))
	attach("POST", "/auth/register", 201, envelope(map[string]any{
		"type":       "object",
		"properties": map[string]any{"user": schemaRef("UserProfile")},
	}))
	attach("POST", "/auth/login", 200, envelope(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"user":           schemaRef("UserProfile"),
			"requires2FA":    map[string]any{"type": "boolean"},
			"twoFactorToken": map[string]any{"type": "string"},
		},
	}))
}

func nullableStringSchema() map[string]any {
	return map[string]any{"type": "string", "nullable": true}
}

func nullableTimeSchema() map[string]any {
	return map[string]any{"type": "string", "format": "date-time", "nullable": true}
}

func dateTimeSchema() map[string]any {
	return map[string]any{"type": "string", "format": "date-time"}
}

func openAPIComponentSchemas() map[string]any {
	return map[string]any{
		"Error": map[string]any{
			"type":     "object",
			"required": []string{"status", "message"},
			"properties": map[string]any{
				"status":  map[string]any{"type": "string", "example": "error"},
				"message": map[string]any{"type": "string"},
			},
		},
		"UserProfile": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "email", "role"},
			"properties": map[string]any{
				"id":                  map[string]any{"type": "string"},
				"email":               map[string]any{"type": "string"},
				"name":                nullableStringSchema(),
				"avatar":              nullableStringSchema(),
				"role":                map[string]any{"type": "string", "enum": []string{"patient", "doctor", "admin"}},
				"phone_number":        nullableStringSchema(),
				"provider":            map[string]any{"type": "string"},
				"isVerified":          map[string]any{"type": "boolean"},
				"weeklyReportEnabled": map[string]any{"type": "boolean"},
				"totpEnabled":         map[string]any{"type": "boolean"},
				"sessionCredits":      map[string]any{"type": "integer"},
				"timezone":            nullableStringSchema(),
				"referralCode":        nullableStringSchema(),
				"createdAt":           dateTimeSchema(),
			},
		},
		"DoctorSummary": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "specialty"},
			"properties": map[string]any{
				"id":                 map[string]any{"type": "string"},
				"specialty":          map[string]any{"type": "string"},
				"experience":         map[string]any{"type": "integer"},
				"price":              map[string]any{"type": "integer"},
				"rating":             map[string]any{"type": "number"},
				"totalReviews":       map[string]any{"type": "integer"},
				"verificationStatus": map[string]any{"type": "string"},
				"user": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name":   nullableStringSchema(),
						"avatar": nullableStringSchema(),
					},
				},
				"_count": map[string]any{
					"type":       "object",
					"properties": map[string]any{"reviews": map[string]any{"type": "integer"}},
				},
			},
		},
		"DoctorDetail": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"properties": map[string]any{
				"id":                   map[string]any{"type": "string"},
				"specialty":            map[string]any{"type": "string"},
				"bio":                  map[string]any{"type": "string"},
				"experience":           map[string]any{"type": "integer"},
				"price":                map[string]any{"type": "integer"},
				"rating":               map[string]any{"type": "number"},
				"totalReviews":         map[string]any{"type": "integer"},
				"licenseNumber":        nullableStringSchema(),
				"licenseIssuer":        nullableStringSchema(),
				"languages":            nullableStringSchema(),
				"education":            nullableStringSchema(),
				"verificationStatus":   map[string]any{"type": "string"},
				"availability":         map[string]any{"type": "string"},
				"availabilityPatterns": map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
				"consultationSlots":    schemaArray("Slot"),
				"reviews":              schemaArray("ReviewPublic"),
			},
		},
		"Slot": map[string]any{
			"type":     "object",
			"required": []string{"id", "doctorId", "startTime", "endTime", "isBooked"},
			"properties": map[string]any{
				"id":        map[string]any{"type": "string"},
				"doctorId":  map[string]any{"type": "string"},
				"date":      dateTimeSchema(),
				"startTime": map[string]any{"type": "string"},
				"endTime":   map[string]any{"type": "string"},
				"isBooked":  map[string]any{"type": "boolean"},
			},
		},
		"MoodEntry": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "userId", "mood", "moodDate"},
			"properties": map[string]any{
				"id":        map[string]any{"type": "string"},
				"userId":    map[string]any{"type": "string"},
				"mood":      map[string]any{"type": "integer", "minimum": 1, "maximum": 5},
				"notes":     nullableStringSchema(),
				"moodDate":  map[string]any{"type": "string", "example": "2026-10-20"},
				"factors":   map[string]any{"description": "JSON array string or array of factor tags"},
				"createdAt": dateTimeSchema(),
			},
		},
		"JournalEntry": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "userId", "content"},
			"properties": map[string]any{
				"id":        map[string]any{"type": "string"},
				"userId":    map[string]any{"type": "string"},
				"content":   map[string]any{"type": "string"},
				"aiSummary": nullableStringSchema(),
				"createdAt": dateTimeSchema(),
			},
		},
		"Notification": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "title", "message"},
			"properties": map[string]any{
				"id":        map[string]any{"type": "string"},
				"title":     map[string]any{"type": "string"},
				"message":   map[string]any{"type": "string"},
				"isRead":    map[string]any{"type": "boolean"},
				"type":      nullableStringSchema(),
				"createdAt": dateTimeSchema(),
			},
		},
		"Appointment": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "appointmentDate", "status"},
			"properties": map[string]any{
				"id":               map[string]any{"type": "string"},
				"appointmentDate":  dateTimeSchema(),
				"startTime":        nullableStringSchema(),
				"endTime":          nullableStringSchema(),
				"consultationType": map[string]any{"type": "string"},
				"status":           map[string]any{"type": "string", "enum": []string{"pending", "confirmed", "cancelled", "completed"}},
				"notes":            nullableStringSchema(),
				"meetingLink":      nullableStringSchema(),
				"creditApplied":    map[string]any{"type": "boolean"},
				"doctor":           map[string]any{"type": "object"},
				"followUp":         map[string]any{"type": "object", "nullable": true},
				"createdAt":        dateTimeSchema(),
			},
		},
		"CarePlan": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "userId", "version"},
			"properties": map[string]any{
				"id":           map[string]any{"type": "string"},
				"userId":       map[string]any{"type": "string"},
				"doctorUserId": nullableStringSchema(),
				"title":        map[string]any{"type": "string"},
				"status":       map[string]any{"type": "string", "enum": []string{"active", "completed", "paused"}},
				"summary":      nullableStringSchema(),
				"reviewAt":     nullableTimeSchema(),
				"closedAt":     nullableTimeSchema(),
				"goals":        map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
				"version":      map[string]any{"type": "integer"},
				"createdAt":    dateTimeSchema(),
				"updatedAt":    dateTimeSchema(),
			},
		},
		"SafetyPlan": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "userId", "version"},
			"properties": map[string]any{
				"id":                  map[string]any{"type": "string"},
				"userId":              map[string]any{"type": "string"},
				"warningSigns":        nullableStringSchema(),
				"copingStrategies":    nullableStringSchema(),
				"reasonsToLive":       nullableStringSchema(),
				"contacts":            map[string]any{"description": "JSON array of contacts", "nullable": true},
				"professionalContact": nullableStringSchema(),
				"locationToBeSafe":    nullableStringSchema(),
				"lastReviewedAt":      nullableTimeSchema(),
				"version":             map[string]any{"type": "integer"},
				"createdAt":           dateTimeSchema(),
				"updatedAt":           dateTimeSchema(),
			},
		},
		"ReviewPublic": map[string]any{
			"type":                 "object",
			"additionalProperties": true,
			"required":             []string{"id", "rating", "comment"},
			"properties": map[string]any{
				"id":          map[string]any{"type": "string"},
				"rating":      map[string]any{"type": "integer", "minimum": 1, "maximum": 5},
				"comment":     map[string]any{"type": "string"},
				"reply":       nullableStringSchema(),
				"repliedAt":   nullableTimeSchema(),
				"createdAt":   dateTimeSchema(),
				"displayName": map[string]any{"type": "string"},
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
