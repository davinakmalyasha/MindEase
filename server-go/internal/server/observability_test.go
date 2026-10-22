package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/davinakmalyasha/MindEase/server-go/internal/config"
)

func metricsTestServer() *Server {
	return New(&config.Config{
		AiCircuitThreshold:  5,
		AiCircuitCooldownMs: 60000,
		RequestTimeout:      time.Second,
	}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestMetricsEndpointRequiresTheConfiguredToken(t *testing.T) {
	s := metricsTestServer()
	h := s.MetricsHandler("scrape-secret")

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a token, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for a wrong token, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer scrape-secret")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with the token, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "go_goroutines") {
		t.Fatal("metrics output does not look like a Prometheus exposition")
	}
}

func TestMetricsMiddlewareUsesTheRoutePatternNotTheRawPath(t *testing.T) {
	s := metricsTestServer()
	r := chi.NewRouter()
	r.Use(s.metricsMiddleware)
	r.Get("/doctors/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/doctors/abc", nil))

	rec := httptest.NewRecorder()
	s.MetricsHandler("").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `mindease_http_requests_total{method="GET",route="/doctors/{id}",status="200"} 1`) {
		t.Fatalf("route-pattern metric missing from scrape:\n%s", body)
	}
}

func TestTimeoutMiddlewareReturns503ForSlowHandlers(t *testing.T) {
	slow := timeoutMiddleware(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_, _ = w.Write([]byte("too late"))
	}))
	rec := httptest.NewRecorder()
	slow.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}

	fast := timeoutMiddleware(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	rec = httptest.NewRecorder()
	fast.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("fast handler should pass through, got %d %q", rec.Code, rec.Body.String())
	}
}

func TestReadyzFailsWhenMySQLIsUnavailable(t *testing.T) {
	s := metricsTestServer()
	rec := httptest.NewRecorder()
	s.readyHandler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without a database, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"db":"unreachable"`) {
		t.Fatalf("unexpected readiness body: %s", rec.Body.String())
	}
}
