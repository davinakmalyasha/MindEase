package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// registerNotifications ports routes/notification.routes.ts and the read side
// of notification.service.ts. Creation itself lives with the domains that
// raise notifications; the preferences helpers below are shared with the
// message domain's send path.
func (s *Server) registerNotifications(api chi.Router) {
	api.With(s.authenticate).Get("/notifications", s.handleNotifList)
	api.With(s.authenticate).Get("/notifications/unread-count", s.handleNotifUnreadCount)
	api.With(s.authenticate).Get("/notifications/preferences", s.handleNotifGetPreferences)
	api.With(s.authenticate).Put("/notifications/preferences", s.handleNotifUpdatePreferences)
	// The Node route validates the id param *before* authenticate, so a
	// malformed id is a 400 even without a session.
	api.With(s.notifValidateIDParam, s.authenticate).Patch("/notifications/{id}/read", s.handleNotifMarkRead)
	api.With(s.authenticate).Patch("/notifications/read-all", s.handleNotifMarkAllRead)
}

// -------------------- preferences --------------------

type notifChannelPrefs struct {
	InApp bool `json:"inApp"`
	Email bool `json:"email"`
}

type notifPrefs struct {
	Appointment notifChannelPrefs `json:"appointment"`
	Message     notifChannelPrefs `json:"message"`
	System      notifChannelPrefs `json:"system"`
}

// notifDefaultPrefs is DEFAULT_PREFS from notification.service.ts.
func notifDefaultPrefs() notifPrefs {
	return notifPrefs{
		Appointment: notifChannelPrefs{InApp: true, Email: false},
		Message:     notifChannelPrefs{InApp: true, Email: false},
		System:      notifChannelPrefs{InApp: true, Email: true},
	}
}

func (p notifPrefs) channel(name string) (notifChannelPrefs, bool) {
	switch name {
	case "appointment":
		return p.Appointment, true
	case "message":
		return p.Message, true
	case "system":
		return p.System, true
	}
	return notifChannelPrefs{}, false
}

func (p *notifPrefs) setChannel(name string, channel notifChannelPrefs) {
	switch name {
	case "appointment":
		p.Appointment = channel
	case "message":
		p.Message = channel
	case "system":
		p.System = channel
	}
}

func (p notifPrefs) channelInApp(name string) bool {
	channel, ok := p.channel(name)
	return ok && channel.InApp
}

// notifParsePrefs ports parsePrefs, including the backward-compatible legacy
// boolean shape and the "anything that is not exactly false is true" reading
// of a stored `inApp` value.
func notifParsePrefs(raw *string) notifPrefs {
	prefs := notifDefaultPrefs()
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return prefs
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return prefs
	}
	for _, name := range []string{"appointment", "message", "system"} {
		value, present := parsed[name]
		if !present {
			continue
		}
		channel, _ := prefs.channel(name)
		switch msgJSONTypeName(value) {
		case "boolean":
			var flag bool
			if json.Unmarshal(value, &flag) == nil {
				channel.InApp = flag
				prefs.setChannel(name, channel)
			}
		case "object":
			var fields map[string]json.RawMessage
			if json.Unmarshal(value, &fields) != nil {
				continue
			}
			if rawInApp, ok := fields["inApp"]; ok {
				var incoming any
				if json.Unmarshal(rawInApp, &incoming) == nil {
					flag, isBool := incoming.(bool)
					channel.InApp = !(isBool && !flag)
				}
			}
			if rawEmail, ok := fields["email"]; ok {
				var incoming any
				if json.Unmarshal(rawEmail, &incoming) == nil {
					flag, isBool := incoming.(bool)
					channel.Email = isBool && flag
				}
			}
			prefs.setChannel(name, channel)
		}
	}
	return prefs
}

// -------------------- helpers shared with the message send path --------------------

// notifGetPrefs is NotificationService.getPreferences: the stored JSON merged
// over the defaults, and the defaults when the row (or column) is absent.
func (s *Server) notifGetPrefs(ctx context.Context, userID string) (notifPrefs, error) {
	var raw sql.NullString
	err := s.DB.QueryRowContext(ctx, "SELECT notificationPrefs FROM `User` WHERE id = ?", userID).Scan(&raw)
	if err == sql.ErrNoRows {
		return notifDefaultPrefs(), nil
	}
	if err != nil {
		return notifDefaultPrefs(), err
	}
	return notifParsePrefs(strPtr(raw)), nil
}

// notifCreate ports the in-app half of NotificationService.create: the
// per-type preference gate, the single sanitisation choke point, and the
// realtime notification:new event. The email copy is intentionally not sent -
// there is no mailer in the Go service yet - so a preference that asks for
// email still creates the in-app row exactly as Node does.
func (s *Server) notifCreate(ctx context.Context, userID, title, message, notificationType string, wantsEmail bool) (bool, error) {
	if notificationType == "" {
		notificationType = "system"
	}
	prefs := notifDefaultPrefs()
	if _, known := prefs.channel(notificationType); known {
		var raw sql.NullString
		var recipientEmail sql.NullString
		err := s.DB.QueryRowContext(ctx,
			"SELECT notificationPrefs, email FROM `User` WHERE id = ?", userID).Scan(&raw, &recipientEmail)
		if err != nil && err != sql.ErrNoRows {
			return false, err
		}
		prefs = notifParsePrefs(strPtr(raw))
		channel, _ := prefs.channel(notificationType)
		if !channel.InApp && !(wantsEmail && channel.Email) {
			return false, nil
		}
		if wantsEmail && channel.Email && recipientEmail.Valid && recipientEmail.String != "" {
			s.Log.Debug("notification email skipped: mailer is not ported to the Go service yet",
				"userId", userID, "type", notificationType)
		}
	}
	if !prefs.channelInApp(notificationType) {
		return false, nil
	}

	sanitizedTitle := s.msgSanitize(title)
	sanitizedMessage := s.msgSanitize(message)
	now := time.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), userID, sanitizedTitle, sanitizedMessage, false, notificationType, now)
	if err != nil {
		return false, err
	}

	s.msgPublish(userID, "notification:new", map[string]any{
		"title":     sanitizedTitle,
		"message":   sanitizedMessage,
		"type":      notificationType,
		"createdAt": nowISO(),
	})
	return true, nil
}

// -------------------- id param validation (before authenticate) --------------------

func (s *Server) notifValidateIDParam(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !msgIsUUID7(chi.URLParam(r, "id")) {
			s.validationFail(w, "params.id", "Invalid id")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// -------------------- GET /notifications --------------------

func (s *Server) handleNotifList(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	query := r.URL.Query()
	page := msgJsIntOr(query.Get("page"), 1)
	limit := msgJsIntOr(query.Get("limit"), 20)
	if limit > 30 {
		limit = 30
	}
	take := limit
	if take < 1 {
		take = 1
	}
	currentPage := page
	if currentPage < 1 {
		currentPage = 1
	}
	skip := (currentPage - 1) * take

	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, userId, title, message, isRead, type, createdAt FROM `Notification` "+
			"WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?",
		user.ID, take, skip)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch notifications.")
		return
	}
	defer rows.Close()

	list := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id        string
			userID    string
			title     string
			message   string
			isRead    bool
			notifType sql.NullString
			createdAt time.Time
		)
		if err := rows.Scan(&id, &userID, &title, &message, &isRead, &notifType, &createdAt); err != nil {
			s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch notifications.")
			return
		}
		list = append(list, map[string]any{
			"id":        id,
			"userId":    userID,
			"title":     title,
			"message":   message,
			"isRead":    isRead,
			"type":      strPtr(notifType),
			"createdAt": jsTimeValue(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch notifications.")
		return
	}

	var total int
	if err := s.DB.QueryRowContext(r.Context(),
		"SELECT COUNT(*) FROM `Notification` WHERE userId = ?", user.ID).Scan(&total); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch notifications.")
		return
	}
	totalPages := 0
	if total > 0 {
		totalPages = (total + take - 1) / take
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"rows":       list,
		"total":      total,
		"page":       currentPage,
		"totalPages": totalPages,
	}})
}

// -------------------- GET /notifications/unread-count --------------------

func (s *Server) handleNotifUnreadCount(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	var count int
	if err := s.DB.QueryRowContext(r.Context(),
		"SELECT COUNT(*) FROM `Notification` WHERE userId = ? AND isRead = FALSE", user.ID).Scan(&count); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to get unread count.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"count": count}})
}

// -------------------- GET/PUT /notifications/preferences --------------------

func (s *Server) handleNotifGetPreferences(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	prefs, err := s.notifGetPrefs(r.Context(), user.ID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to get preferences.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": prefs})
}

func (s *Server) handleNotifUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	keys, fields, ok := s.msgBodyFields(w, r)
	if !ok {
		return
	}

	// Only the three known categories are persisted, each coerced to the
	// {inApp, email} shape; a malformed payload is a union failure, exactly as
	// NotificationPrefsSchema reports it.
	clean := notifDefaultPrefs()
	for _, name := range []string{"appointment", "message", "system"} {
		raw, present := fields[name]
		if !present {
			continue
		}
		channel, _ := clean.channel(name)
		switch msgJSONTypeName(raw) {
		case "boolean":
			var flag bool
			if json.Unmarshal(raw, &flag) == nil {
				channel.InApp = flag
				clean.setChannel(name, channel)
			}
		case "object":
			var objectFields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &objectFields); err != nil {
				s.validationFail(w, "body."+name, "Invalid input")
				return
			}
			if rawInApp, present := objectFields["inApp"]; present {
				if msgJSONTypeName(rawInApp) != "boolean" {
					s.validationFail(w, "body."+name, "Invalid input")
					return
				}
				var flag bool
				_ = json.Unmarshal(rawInApp, &flag)
				channel.InApp = flag
			}
			if rawEmail, present := objectFields["email"]; present {
				if msgJSONTypeName(rawEmail) != "boolean" {
					s.validationFail(w, "body."+name, "Invalid input")
					return
				}
				var flag bool
				_ = json.Unmarshal(rawEmail, &flag)
				channel.Email = flag
			}
			clean.setChannel(name, channel)
		default:
			s.validationFail(w, "body."+name, "Invalid input")
			return
		}
	}

	// Strict schema: unknown top-level keys are rejected in payload order.
	var unknown []string
	for _, key := range keys {
		switch key {
		case "appointment", "message", "system":
		default:
			unknown = append(unknown, `"`+key+`"`)
		}
	}
	if len(unknown) == 1 {
		s.validationFail(w, "body", "Unrecognized key: "+unknown[0])
		return
	}
	if len(unknown) > 1 {
		s.validationFail(w, "body", "Unrecognized keys: "+strings.Join(unknown, ", "))
		return
	}

	raw, err := json.Marshal(clean)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to update preferences.")
		return
	}
	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `User` SET notificationPrefs = ?, updatedAt = ? WHERE id = ?",
		string(raw), time.Now().UTC(), user.ID); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to update preferences.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": clean})
}

// -------------------- PATCH /notifications/:id/read, /read-all --------------------

func (s *Server) handleNotifMarkRead(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	notificationID := chi.URLParam(r, "id")
	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `Notification` SET isRead = TRUE WHERE id = ? AND userId = ?", notificationID, user.ID); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to mark as read.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success"})
}

func (s *Server) handleNotifMarkAllRead(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `Notification` SET isRead = TRUE WHERE userId = ? AND isRead = FALSE", user.ID); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to mark all as read.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success"})
}
