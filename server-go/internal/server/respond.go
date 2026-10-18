package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// AppError is a failure whose message is safe to show a client, mirroring
// server/src/utils/appError.ts. Anything else is reported as a generic 500.
type AppError struct {
	Status  int
	Message string
	Extra   map[string]any
}

func (e *AppError) Error() string { return e.Message }

func BadRequest(msg string) *AppError { return &AppError{Status: http.StatusBadRequest, Message: msg} }
func Unauthorized(msg string) *AppError {
	if msg == "" {
		msg = "Unauthorized"
	}
	return &AppError{Status: http.StatusUnauthorized, Message: msg}
}
func Forbidden(msg string) *AppError {
	if msg == "" {
		msg = "Forbidden"
	}
	return &AppError{Status: http.StatusForbidden, Message: msg}
}
func NotFound(msg string) *AppError {
	if msg == "" {
		msg = "Not found"
	}
	return &AppError{Status: http.StatusNotFound, Message: msg}
}
func Conflict(msg string) *AppError { return &AppError{Status: http.StatusConflict, Message: msg} }

// JSON writes an arbitrary value with a status code.
func (s *Server) JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		if err := json.NewEncoder(w).Encode(v); err != nil {
			s.Log.Error("response encode failed", "err", err)
		}
	}
}

// Fail writes the standard error envelope: {"status":"error","message":...}.
func (s *Server) Fail(w http.ResponseWriter, status int, message string) {
	s.JSON(w, status, map[string]any{"status": "error", "message": message})
}

// FailExtra spreads machine-readable fields into the envelope, e.g.
// {"status":"error","message":"Two-factor verification required","code":"TOTP_REQUIRED"}.
func (s *Server) FailExtra(w http.ResponseWriter, status int, message string, extra map[string]any) {
	body := map[string]any{"status": "error", "message": message}
	for k, v := range extra {
		body[k] = v
	}
	s.JSON(w, status, body)
}

// AppErr maps a domain error to a response: typed *AppError keeps its status
// and message; anything else is logged and reported as a generic failure with
// the request id, exactly like the Node error handler's backstop.
func (s *Server) AppErr(w http.ResponseWriter, r *http.Request, err error) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.FailExtra(w, appErr.Status, appErr.Message, appErr.Extra)
		return
	}
	s.Log.Error("handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.FailExtra(w, http.StatusInternalServerError, "Something went wrong. Please try again.", map[string]any{
		"requestId": RequestID(r),
	})
}

// DecodeJSON reads a size-limited JSON body into v.
func DecodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return BadRequest("Invalid request body")
	}
	return nil
}

func logLevelFor(status int) slog.Level {
	switch {
	case status >= 500:
		return slog.LevelError
	case status >= 400:
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}
