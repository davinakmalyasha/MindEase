package server

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
)

const (
	csrfCookieName = "csrfToken"
	csrfHeaderName = "x-csrf-token"
)

// csrfMiddleware is the double-submit token from middleware/csrf.middleware.ts.
// The payment notification and the internal worker trigger are exempt for the
// same reasons as in Node: no browser cookie is involved in either.
func (s *Server) csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/payments/notification" || strings.HasPrefix(r.URL.Path, "/api/internal") {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(csrfCookieName)
		header := r.Header.Get(csrfHeaderName)
		if err != nil || cookie.Value == "" || header == "" || cookie.Value != header {
			s.Fail(w, http.StatusForbidden, "Invalid CSRF token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) csrfTokenHandler(w http.ResponseWriter, r *http.Request) {
	token := ""
	if c, err := r.Cookie(csrfCookieName); err == nil {
		token = c.Value
	}
	if token == "" {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			s.Fail(w, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		token = hex.EncodeToString(raw)
		http.SetCookie(w, &http.Cookie{
			Name:     csrfCookieName,
			Value:    token,
			Path:     "/",
			HttpOnly: false, // readable by the client, echoed back in the header
			Secure:   s.Cfg.IsProd,
			SameSite: http.SameSiteLaxMode,
		})
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"csrfToken": token}})
}
