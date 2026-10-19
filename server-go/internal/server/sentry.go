package server

import (
	"net/http"

	"github.com/getsentry/sentry-go"
)

// captureError reports an unexpected failure to Sentry with the same request
// context the logs carry. sentry-go is a no-op until main initialises a client,
// which is what keeps this safe in tests and in deployments without a DSN.
func (s *Server) captureError(r *http.Request, err error) {
	sentry.WithScope(func(scope *sentry.Scope) {
		scope.SetTag("request_id", RequestID(r))
		scope.SetTag("http.path", r.URL.Path)
		scope.SetTag("http.method", r.Method)
		sentry.CaptureException(err)
	})
}
