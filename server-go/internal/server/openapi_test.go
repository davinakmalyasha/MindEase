package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestOpenAPIReferencesResolveAndBindResponses(t *testing.T) {
	s := New(testConfig(t), nil, nil, itLog)
	rec := httptest.NewRecorder()
	s.Mount().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("openapi: %d", rec.Code)
	}
	var doc struct {
		Components struct {
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("openapi is not JSON: %v", err)
	}
	if len(doc.Components.Schemas) < 10 {
		t.Fatalf("components.schemas has %d entries; want the core resources", len(doc.Components.Schemas))
	}

	refs := map[string]bool{}
	collectRefs(doc.Paths, refs)
	for ref := range refs {
		name := strings.TrimPrefix(ref, "#/components/schemas/")
		if _, ok := doc.Components.Schemas[name]; !ok {
			t.Errorf("unresolved schema reference %q", ref)
		}
	}

	bindings := []struct{ path, method, status string }{
		{"/users/profile", "get", "200"},
		{"/users/profile", "put", "200"},
		{"/ai/briefing", "post", "200"},
		{"/ai/copilot-draft", "post", "200"},
		{"/doctors", "get", "200"},
		{"/doctors/{id}", "get", "200"},
		{"/wellness/mood", "get", "200"},
		{"/notifications", "get", "200"},
		{"/appointments/my", "get", "200"},
		{"/auth/login", "post", "200"},
	}
	for _, binding := range bindings {
		item, ok := doc.Paths[binding.path].(map[string]any)
		if !ok {
			t.Errorf("missing path %s", binding.path)
			continue
		}
		operation, ok := item[binding.method].(map[string]any)
		if !ok {
			t.Errorf("missing operation %s %s", binding.method, binding.path)
			continue
		}
		response, ok := operation["responses"].(map[string]any)[binding.status].(map[string]any)
		if !ok || response["content"] == nil {
			t.Errorf("%s %s has no response schema", binding.method, binding.path)
		}
	}
}

func collectRefs(value any, out map[string]bool) {
	switch typed := value.(type) {
	case map[string]any:
		if ref, ok := typed["$ref"].(string); ok {
			out[ref] = true
		}
		for _, child := range typed {
			collectRefs(child, out)
		}
	case []any:
		for _, child := range typed {
			collectRefs(child, out)
		}
	}
}
