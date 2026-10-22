package server

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"uuid"
)

// newID returns a UUIDv7: the same primary-key scheme Prisma writes, from the
// Go 1.27 standard library.
func newID() string { return uuid.NewV7().String() }

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}

// Hijack keeps websocket-capable wrapping possible if a route ever upgrades.
func (sr *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := sr.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("hijack not supported")
	}
	return h.Hijack()
}

var requestIDPattern = regexp.MustCompile(`^[\w-]{1,64}$`)

func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !requestIDPattern.MatchString(id) {
			id = newID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(withRequestID(r.Context(), id)))
	})
}

func RequestID(r *http.Request) string {
	if id, ok := r.Context().Value(requestIDContextKey).(string); ok {
		return id
	}
	return ""
}

func withRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDContextKey, id)
}

var processStarted = time.Now()

func uptimeSeconds() float64 { return time.Since(processStarted).Seconds() }

// nowISO matches JavaScript's Date#toISOString shape.
func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func ptr[T any](v T) *T { return &v }

// securityHeaders is the helmet subset that matters for an API origin.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("X-XSS-Protection", "0")
		h.Set("X-DNS-Prefetch-Control", "off")
		h.Set("X-Download-Options", "noopen")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		if s.Cfg.IsProd {
			h.Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedOrigin(origin string) bool {
	for _, o := range s.Cfg.CORSOrigins {
		if o == origin {
			return true
		}
	}
	return false
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.allowedOrigin(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Request-Id")
			h.Set("Access-Control-Max-Age", "86400")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) bodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			// The 1 MB cap is express.json's; multipart carries its own
			// per-route ceiling (multer's 5 MB in the upload route).
			next.ServeHTTP(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		next.ServeHTTP(w, r)
	})
}

// accessLog records method, path (never the query values), status and
// duration, mirroring the pino-http serialiser's privacy choices.
func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/health") || r.URL.Path == "/api/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"durationMs", time.Since(start).Milliseconds(),
			"requestId", RequestID(r),
			"remoteAddress", remoteIP(r, s.Cfg.IsProd),
		}
		if len(r.URL.Query()) > 0 {
			keys := make([]string, 0, len(r.URL.Query()))
			for k := range r.URL.Query() {
				keys = append(keys, k)
			}
			attrs = append(attrs, "queryKeys", keys)
		}
		s.Log.Log(r.Context(), logLevelFor(rec.status), "request", attrs...)
	})
}

// timeoutMiddleware bounds every request, including handlers that would
// otherwise keep running after the client has gone. http.TimeoutHandler is
// used rather than a context-only deadline because several handlers do work
// that does not consult the context (sanitising, template building); the
// response is a deterministic 503 instead of a connection reset.
func timeoutMiddleware(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if d <= 0 {
			return next
		}
		return http.TimeoutHandler(next, d, `{"status":"error","error":"Request timed out"}`)
	}
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.captureError(r, fmt.Errorf("panic: %v", rec))
				s.Log.Error("panic recovered", "panic", rec, "path", r.URL.Path, "requestId", RequestID(r))
				s.FailExtra(w, http.StatusInternalServerError, "Something went wrong. Please try again.", map[string]any{
					"requestId": RequestID(r),
				})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// remoteIP picks the client address the same way Express does with
// `trust proxy = 1` in production: the last X-Forwarded-For entry, because
// exactly one proxy sits in front. In development the socket address is used.
func remoteIP(r *http.Request, isProd bool) string {
	if isProd {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
