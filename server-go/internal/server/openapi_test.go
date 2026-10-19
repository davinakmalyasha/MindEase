package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAPIDocumentListsMountedRoutes(t *testing.T) {
	s := New(testConfig(t), nil, nil, itLog)
	rec := httptest.NewRecorder()
	s.Mount().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("openapi: %d %s", rec.Code, rec.Body.String())
	}

	var doc struct {
		OpenAPI    string                    `json:"openapi"`
		Paths      map[string]map[string]any `json:"paths"`
		Components map[string]any            `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("openapi is not JSON: %v", err)
	}
	if doc.OpenAPI != "3.0.3" {
		t.Fatalf("openapi version = %q", doc.OpenAPI)
	}
	if len(doc.Paths) < 100 {
		t.Fatalf("document lists %d paths; the router mounts far more", len(doc.Paths))
	}

	known := []struct{ path, method string }{
		{"/auth/login", "post"},
		{"/auth/refresh", "post"},
		{"/wellness/mood", "get"},
		{"/wellness/mood", "post"},
		{"/appointments/book", "post"},
		{"/payments/packages/{id}/checkout", "post"},
		{"/admin/stats", "get"},
		{"/internal/jobs/{name}", "post"},
		{"/health", "get"},
	}
	for _, pair := range known {
		if _, present := doc.Paths[pair.path][pair.method]; !present {
			t.Errorf("openapi is missing %s %s", pair.method, pair.path)
		}
	}

	health := doc.Paths["/health"]["get"].(map[string]any)
	if _, present := health["security"]; present {
		t.Error("health is documented as requiring a session")
	}
	mood := doc.Paths["/wellness/mood"]["post"].(map[string]any)
	security, present := mood["security"].([]any)
	if !present || len(security) == 0 {
		t.Error("an authenticated route is documented without a security requirement")
	}
	if doc.Components["securitySchemes"] == nil {
		t.Error("the document has no security schemes")
	}
}
