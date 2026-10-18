package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-sql-driver/mysql"
)

// registerPush ports routes/push.routes.ts and the registration half of
// push.service.ts. Outbound web-push delivery (web-push's sendNotification)
// is deliberately not ported: the Go service stores and deletes subscriptions
// and hands out the VAPID key, but never calls a push provider.
func (s *Server) registerPush(api chi.Router) {
	api.Group(func(r chi.Router) {
		r.Use(s.authenticate)
		r.Get("/push/public-key", s.handlePushPublicKey)
		r.Post("/push/subscribe", s.handlePushSubscribe)
		r.Post("/push/unsubscribe", s.handlePushUnsubscribe)
	})
}

// handlePushPublicKey returns VAPID_PUBLIC_KEY verbatim (or null when it is
// not configured), which is the base64url form the browser's Push API needs.
func (s *Server) handlePushPublicKey(w http.ResponseWriter, _ *http.Request) {
	key := os.Getenv("VAPID_PUBLIC_KEY")
	var publicKey any
	if key != "" {
		publicKey = key
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"publicKey": publicKey,
	}})
}

// handlePushSubscribe validates PushSubscribeSchema and upserts the
// subscription keyed by (userId, endpoint) - the unique pair that keeps a
// second user on a shared device from overwriting the first user's keys.
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	_, fields, ok := s.msgBodyFields(w, r)
	if !ok {
		return
	}

	endpointRaw, present := fields["endpoint"]
	if !present {
		s.validationFail(w, "body.endpoint", "Invalid input: expected string, received undefined")
		return
	}
	endpoint, ok := s.msgValidateString(w, "body.endpoint", endpointRaw)
	if !ok {
		return
	}
	if len(endpoint) < 10 {
		s.validationFail(w, "body.endpoint", "Invalid endpoint")
		return
	}

	keysRaw, present := fields["keys"]
	if !present {
		s.validationFail(w, "body.keys", "Invalid input: expected object, received undefined")
		return
	}
	if msgJSONTypeName(keysRaw) != "object" {
		s.validationFail(w, "body.keys", "Invalid input: expected object, received "+msgJSONTypeName(keysRaw))
		return
	}
	var keyFields map[string]json.RawMessage
	if err := json.Unmarshal(keysRaw, &keyFields); err != nil {
		s.validationFail(w, "body.keys", "Invalid input: expected object, received object")
		return
	}

	p256dhRaw, present := keyFields["p256dh"]
	if !present {
		s.validationFail(w, "body.keys.p256dh", "Invalid input: expected string, received undefined")
		return
	}
	p256dh, ok := s.msgValidateString(w, "body.keys.p256dh", p256dhRaw)
	if !ok {
		return
	}
	if len(p256dh) < 10 {
		s.validationFail(w, "body.keys.p256dh", "Too small: expected string to have >=10 characters")
		return
	}

	authRaw, present := keyFields["auth"]
	if !present {
		s.validationFail(w, "body.keys.auth", "Invalid input: expected string, received undefined")
		return
	}
	auth, ok := s.msgValidateString(w, "body.keys.auth", authRaw)
	if !ok {
		return
	}
	if len(auth) < 5 {
		s.validationFail(w, "body.keys.auth", "Too small: expected string to have >=5 characters")
		return
	}

	if len(endpoint) > 500 {
		s.Fail(w, http.StatusBadRequest, "Push endpoint is too long")
		return
	}
	// The columns are VARCHAR(500); Prisma reports an over-long value as a
	// driver error, which the controller discloses as its fallback.
	if len(p256dh) > 500 || len(auth) > 500 {
		s.Fail(w, http.StatusBadRequest, "Failed to subscribe.")
		return
	}

	var userAgent any
	if ua := r.UserAgent(); ua != "" {
		userAgent = ua
	}

	id, err := s.pushUpsertSubscription(r, user.ID, endpoint, p256dh, auth, userAgent)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to subscribe.")
		return
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{"id": id}})
}

// pushUpsertSubscription is PushSubscription.upsert on the (userId, endpoint)
// unique key: rotate the keys of an existing row in place, or create one.
func (s *Server) pushUpsertSubscription(r *http.Request, userID, endpoint, p256dh, auth string, userAgent any) (string, error) {
	var id string
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT id FROM `PushSubscription` WHERE userId = ? AND endpoint = ?", userID, endpoint).Scan(&id)
	switch {
	case err == sql.ErrNoRows:
		id = newID()
		_, err = s.DB.ExecContext(r.Context(),
			"INSERT INTO `PushSubscription` (id, userId, endpoint, p256dh, auth, userAgent, createdAt) VALUES (?,?,?,?,?,?,?)",
			id, userID, endpoint, p256dh, auth, userAgent, time.Now().UTC())
		if err != nil {
			var mysqlErr *mysql.MySQLError
			if errors.As(err, &mysqlErr) && mysqlErr.Number == 1062 {
				// A concurrent subscribe won the insert; update that row.
				if _, updateErr := s.DB.ExecContext(r.Context(),
					"UPDATE `PushSubscription` SET p256dh = ?, auth = ?, userAgent = ? WHERE userId = ? AND endpoint = ?",
					p256dh, auth, userAgent, userID, endpoint); updateErr != nil {
					return "", updateErr
				}
				if selectErr := s.DB.QueryRowContext(r.Context(),
					"SELECT id FROM `PushSubscription` WHERE userId = ? AND endpoint = ?", userID, endpoint).Scan(&id); selectErr != nil {
					return "", selectErr
				}
				return id, nil
			}
			return "", err
		}
		return id, nil
	case err != nil:
		return "", err
	default:
		if _, err := s.DB.ExecContext(r.Context(),
			"UPDATE `PushSubscription` SET p256dh = ?, auth = ?, userAgent = ? WHERE id = ?",
			p256dh, auth, userAgent, id); err != nil {
			return "", err
		}
		return id, nil
	}
}

// handlePushUnsubscribe deletes the caller's subscription for one endpoint.
// An absent endpoint mirrors the Node destructuring of an undefined value into
// Prisma's deleteMany, which strips the field and removes every subscription
// for the user.
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)

	var endpoint *string
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			s.Fail(w, http.StatusBadRequest, "request entity too large")
			return
		}
		s.Fail(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed != "" {
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(trimmed), &fields) != nil {
			s.Fail(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if endpointRaw, present := fields["endpoint"]; present {
			if msgJSONTypeName(endpointRaw) != "string" {
				s.Fail(w, http.StatusBadRequest, "Failed to unsubscribe.")
				return
			}
			var value string
			if err := json.Unmarshal(endpointRaw, &value); err != nil {
				s.Fail(w, http.StatusBadRequest, "Failed to unsubscribe.")
				return
			}
			endpoint = &value
		}
	}

	if endpoint == nil {
		if _, err := s.DB.ExecContext(r.Context(),
			"DELETE FROM `PushSubscription` WHERE userId = ?", user.ID); err != nil {
			s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to unsubscribe.")
			return
		}
	} else {
		if _, err := s.DB.ExecContext(r.Context(),
			"DELETE FROM `PushSubscription` WHERE userId = ? AND endpoint = ?", user.ID, *endpoint); err != nil {
			s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to unsubscribe.")
			return
		}
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}
