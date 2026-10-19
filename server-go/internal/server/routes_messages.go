package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
)

// registerMessages ports routes/message.routes.ts and services/message.service.ts.
// The upload route's multer limits (5MB file, 64KB fields, 8 fields, 1 file,
// 9 parts) are enforced by hand below; S3 storage is deliberately not ported -
// uploads always land on local disk under Cfg.UploadDir, like storage.ts's
// fallback branch.
func (s *Server) registerMessages(api chi.Router) {
	writeLimiter := s.limiter(rateLimitConfig{
		name:    "write:message",
		window:  10 * time.Minute,
		max:     60,
		message: "Too many message requests, please slow down",
		key: func(r *http.Request) string {
			if user := CurrentUser(r); user != nil {
				return "u" + user.ID
			}
			return "ip:" + remoteIP(r, s.Cfg.IsProd)
		},
	})
	api.Group(func(r chi.Router) {
		r.Use(s.authenticate)
		r.Get("/messages/conversations", s.handleMsgConversations)
		r.Get("/messages/contacts", s.handleMsgContacts)
		r.Post("/messages/upload", s.handleMsgUpload)
		r.Get("/messages/{userId}/messages", s.handleMsgThread)
		r.Post("/messages/{userId}/typing", s.handleMsgTyping)
		r.With(writeLimiter).Post("/messages/{userId}", s.handleMsgSend)
		r.Delete("/messages/{id}", s.handleMsgDelete)
		r.Put("/messages/{id}/reaction", s.handleMsgReaction)
	})
}

// msgRealtimeChannel is the Redis pub/sub channel server-realtime subscribes to.
const msgRealtimeChannel = "mindease:events"

// msgRealtimeEvent is the exact envelope realtime.service.ts publishes:
// {"userId","type","payload"}.
type msgRealtimeEvent struct {
	UserID  string `json:"userId"`
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// msgPublish ports publishEvent: fire-and-forget, silent when Redis is absent,
// and skipped under NODE_ENV=test (the Node service polls in tests).
func (s *Server) msgPublish(userID, eventType string, payload any) {
	if s.Cfg.IsTest || s.Redis == nil {
		return
	}
	raw, err := json.Marshal(msgRealtimeEvent{UserID: userID, Type: eventType, Payload: payload})
	if err != nil {
		s.Log.Warn("failed to encode realtime event", "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Redis.Publish(ctx, msgRealtimeChannel, raw).Err(); err != nil {
		s.Log.Warn("failed to publish realtime event", "err", err)
	}
}

// msgRespondError mirrors the controllers' catch blocks: typed AppErrors keep
// their status and message, anything else falls back to the per-endpoint
// message the Node controller uses when publicMessageFor returns null.
func (s *Server) msgRespondError(w http.ResponseWriter, r *http.Request, err error, fallbackStatus int, fallbackMessage string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("messages handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, fallbackStatus, fallbackMessage)
}

// -------------------- validation helpers --------------------

var msgUUID7Pattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func msgIsUUID7(value string) bool { return msgUUID7Pattern.MatchString(value) }

func msgDigitsOnly(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// msgJsParseInt mimics JavaScript's parseInt(value, 10): leading whitespace, an
// optional sign, then digits up to the first non-digit. ok=false is NaN.
func msgJsParseInt(value string) (int, bool) {
	i := 0
	for i < len(value) && (value[i] == ' ' || value[i] == '\t' || value[i] == '\n' || value[i] == '\r' || value[i] == '\v' || value[i] == '\f') {
		i++
	}
	sign := 1
	if i < len(value) && (value[i] == '+' || value[i] == '-') {
		if value[i] == '-' {
			sign = -1
		}
		i++
	}
	start := i
	for i < len(value) && value[i] >= '0' && value[i] <= '9' {
		i++
	}
	if start == i {
		return 0, false
	}
	n := 0
	for _, c := range value[start:i] {
		n = n*10 + int(c-'0')
		if n > 1_000_000_000 {
			n = 1_000_000_000
			break
		}
	}
	return sign * n, true
}

// msgJsIntOr mirrors `parseInt(value) || fallback`.
func msgJsIntOr(value string, fallback int) int {
	if v, ok := msgJsParseInt(value); ok && v != 0 {
		return v
	}
	return fallback
}

// msgJSONTypeName names a JSON value the way Zod does in "received X".
func msgJSONTypeName(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "undefined"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		return "number"
	}
}

// msgBodyFields decodes the request body into its top-level fields. An empty
// body is `{}`, mirroring `req.body ?? {}`. A non-object root fails with the
// Zod-style message; a malformed body is a validation failure and returns
// ok=false. keys preserves the JSON order so strict-object schemas can list
// unrecognized keys the way Zod does.
func (s *Server) msgBodyFields(w http.ResponseWriter, r *http.Request) ([]string, map[string]json.RawMessage, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			s.Fail(w, http.StatusBadRequest, "request entity too large")
			return nil, nil, false
		}
		s.validationFail(w, "body", "Validation Error")
		return nil, nil, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, map[string]json.RawMessage{}, true
	}
	if trimmed[0] != '{' {
		s.validationFail(w, "body", "Invalid input: expected object, received "+msgJSONTypeName(json.RawMessage(trimmed)))
		return nil, nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &fields); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return nil, nil, false
	}
	// Key order for the strict-schema paths: decode again with a token stream,
	// because a Go map loses it and Zod reports unknown keys in payload order.
	var keys []string
	seen := map[string]bool{}
	dec := json.NewDecoder(strings.NewReader(trimmed))
	if tok, err := dec.Token(); err == nil {
		if delim, ok := tok.(json.Delim); ok && delim == '{' {
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					break
				}
				key, ok := keyToken.(string)
				if !ok {
					break
				}
				var discard json.RawMessage
				if err := dec.Decode(&discard); err != nil {
					break
				}
				if !seen[key] {
					seen[key] = true
					keys = append(keys, key)
				}
			}
		}
	}
	return keys, fields, true
}

// msgValidateString mirrors `z.string()` for one field, including the exact
// Zod type-error message.
func (s *Server) msgValidateString(w http.ResponseWriter, path string, raw json.RawMessage) (string, bool) {
	valueType := msgJSONTypeName(raw)
	if valueType != "string" {
		s.validationFail(w, path, "Invalid input: expected string, received "+valueType)
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		s.validationFail(w, path, "Invalid input: expected string, received string")
		return "", false
	}
	return value, true
}

// msgValidateBool mirrors `z.boolean()`.
func (s *Server) msgValidateBool(w http.ResponseWriter, path string, raw json.RawMessage) (bool, bool) {
	valueType := msgJSONTypeName(raw)
	if valueType != "boolean" {
		s.validationFail(w, path, "Invalid input: expected boolean, received "+valueType)
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		s.validationFail(w, path, "Invalid input: expected boolean, received boolean")
		return false, false
	}
	return value, true
}

// msgUUIDParam mirrors the uuid7 params schema: message "Invalid id".
func (s *Server) msgUUIDParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	value := chi.URLParam(r, name)
	if !msgIsUUID7(value) {
		s.validationFail(w, "params."+name, "Invalid id")
		return "", false
	}
	return value, true
}

// msgStripTagsPolicy is applied after s.Sanitizer: the port's UGC policy
// allows formatting tags, but the Node sanitize() it ports is configured with
// `allowedTags: []` - every tag is removed and only the text survives. The
// second pass reproduces that output exactly (and keeps markup out of the
// stored message, which is what the crisis-triage test pins).
var msgStripTagsPolicy = bluemonday.StripTagsPolicy()

// msgSanitize is utils/sanitize.ts: trim, strip markup, cap at 4000 UTF-16
// code units.
func (s *Server) msgSanitize(input string) string {
	cleaned := s.Sanitizer.Sanitize(strings.TrimSpace(input))
	cleaned = msgStripTagsPolicy.Sanitize(cleaned)
	return msgTruncateUTF16(cleaned, 4000)
}

func msgTruncateUTF16(value string, max int) string {
	units := 0
	for i, r := range value {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > max {
			return value[:i]
		}
		units += size
	}
	return value
}

// -------------------- shared row shapes --------------------

type msgRow struct {
	ID             string
	Content        string
	SenderID       string
	ReceiverID     string
	IsRead         bool
	ReadAt         sql.NullTime
	AttachmentURL  sql.NullString
	AttachmentType sql.NullString
	DeletedAt      sql.NullTime
	Reaction       sql.NullString
	CreatedAt      time.Time
}

const msgRowColumns = "id, content, senderId, receiverId, isRead, readAt, attachmentUrl, attachmentType, deletedAt, reaction, createdAt"

func scanMsgRow(scan func(...any) error) (msgRow, error) {
	var m msgRow
	err := scan(&m.ID, &m.Content, &m.SenderID, &m.ReceiverID, &m.IsRead, &m.ReadAt,
		&m.AttachmentURL, &m.AttachmentType, &m.DeletedAt, &m.Reaction, &m.CreatedAt)
	return m, err
}

func msgTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

// msgRowJSON renders a message the way Prisma serialises the model. With
// hideDeleted, a soft-deleted row keeps only its metadata - content and
// attachment columns are nulled so the thread can render a tombstone.
func msgRowJSON(m *msgRow, hideDeleted bool) map[string]any {
	var content any = m.Content
	var attachmentURL any = strPtr(m.AttachmentURL)
	var attachmentType any = strPtr(m.AttachmentType)
	if hideDeleted && m.DeletedAt.Valid {
		content = nil
		attachmentURL = nil
		attachmentType = nil
	}
	return map[string]any{
		"id":             m.ID,
		"content":        content,
		"senderId":       m.SenderID,
		"receiverId":     m.ReceiverID,
		"isRead":         m.IsRead,
		"readAt":         jsTime(msgTimePtr(m.ReadAt)),
		"attachmentUrl":  attachmentURL,
		"attachmentType": attachmentType,
		"deletedAt":      jsTime(msgTimePtr(m.DeletedAt)),
		"reaction":       strPtr(m.Reaction),
		"createdAt":      jsTimeValue(m.CreatedAt),
	}
}

// -------------------- service helpers --------------------

// msgCanChat is MessageService.canChat: a confirmed or completed appointment
// must connect the two users (either as patient or as the doctor's account).
func (s *Server) msgCanChat(ctx context.Context, actorID, otherUserID string) (bool, error) {
	var one int
	err := s.DB.QueryRowContext(ctx,
		"SELECT 1 FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId "+
			"WHERE a.status IN ('confirmed','completed') AND ((a.userId = ? AND d.userId = ?) OR (a.userId = ? AND d.userId = ?)) LIMIT 1",
		actorID, otherUserID, otherUserID, actorID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// -------------------- GET /messages/conversations --------------------

func (s *Server) handleMsgConversations(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT m.senderId, m.receiverId, m.content, m.attachmentUrl, m.deletedAt, m.isRead, m.createdAt, "+
			"su.id, su.name, su.avatar, su.role, ru.id, ru.name, ru.avatar, ru.role "+
			"FROM `Message` m JOIN `User` su ON su.id = m.senderId JOIN `User` ru ON ru.id = m.receiverId "+
			"WHERE m.senderId = ? OR m.receiverId = ? ORDER BY m.createdAt DESC LIMIT 500",
		user.ID, user.ID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch conversations.")
		return
	}
	defer rows.Close()

	type msgConversation struct {
		user              map[string]any
		lastMessage       any
		lastMessageAt     time.Time
		lastMessageFromMe bool
		unreadCount       int
	}
	conversations := map[string]*msgConversation{}
	var order []string

	for rows.Next() {
		var (
			senderID, receiverID, content string
			attachmentURL                 sql.NullString
			deletedAt                     sql.NullTime
			isRead                        bool
			createdAt                     time.Time
			senderUserID                  string
			senderName, senderAvatar      sql.NullString
			senderRole                    string
			receiverUserID                string
			receiverName, receiverAvatar  sql.NullString
			receiverRole                  string
		)
		if err := rows.Scan(&senderID, &receiverID, &content, &attachmentURL, &deletedAt, &isRead, &createdAt,
			&senderUserID, &senderName, &senderAvatar, &senderRole,
			&receiverUserID, &receiverName, &receiverAvatar, &receiverRole); err != nil {
			s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch conversations.")
			return
		}

		fromMe := senderID == user.ID
		otherID := receiverUserID
		otherUser := map[string]any{"id": receiverUserID, "name": strPtr(receiverName), "avatar": strPtr(receiverAvatar), "role": receiverRole}
		if !fromMe {
			otherID = senderUserID
			otherUser = map[string]any{"id": senderUserID, "name": strPtr(senderName), "avatar": strPtr(senderAvatar), "role": senderRole}
		}

		existing, seen := conversations[otherID]
		if !seen {
			var lastMessage any
			switch {
			case deletedAt.Valid:
				lastMessage = "Message deleted"
			case attachmentURL.Valid && attachmentURL.String != "":
				if content != "" {
					lastMessage = content
				} else {
					lastMessage = "📎 Attachment"
				}
			default:
				lastMessage = content
			}
			incomingUnread := 0
			if !fromMe && !isRead {
				incomingUnread = 1
			}
			conversations[otherID] = &msgConversation{
				user:              otherUser,
				lastMessage:       lastMessage,
				lastMessageAt:     createdAt,
				lastMessageFromMe: fromMe,
				unreadCount:       incomingUnread,
			}
			order = append(order, otherID)
			continue
		}
		if !fromMe && !isRead {
			existing.unreadCount++
		}
	}
	if err := rows.Err(); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch conversations.")
		return
	}

	sort.SliceStable(order, func(i, j int) bool {
		return conversations[order[i]].lastMessageAt.After(conversations[order[j]].lastMessageAt)
	})

	list := make([]map[string]any, 0, len(order))
	for _, id := range order {
		c := conversations[id]
		list = append(list, map[string]any{
			"user":              c.user,
			"lastMessage":       c.lastMessage,
			"lastMessageAt":     jsTimeValue(c.lastMessageAt),
			"lastMessageFromMe": c.lastMessageFromMe,
			"unreadCount":       c.unreadCount,
		})
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": list})
}

// -------------------- GET /messages/contacts --------------------

func (s *Server) handleMsgContacts(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT u.id, u.name, u.avatar, u.role, du.id, du.name, du.avatar, du.role "+
			"FROM `Appointment` a JOIN `User` u ON u.id = a.userId JOIN `Doctor` d ON d.id = a.doctorId "+
			"JOIN `User` du ON du.id = d.userId "+
			"WHERE a.status IN ('confirmed','completed') AND (a.userId = ? OR d.userId = ?) ORDER BY a.id DESC",
		user.ID, user.ID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch contacts.")
		return
	}
	defer rows.Close()

	seen := map[string]bool{}
	list := make([]map[string]any, 0)
	for rows.Next() {
		var (
			patientID                  string
			patientName, patientAvatar sql.NullString
			patientRole                string
			doctorUserID               string
			doctorName, doctorAvatar   sql.NullString
			doctorRole                 string
		)
		if err := rows.Scan(&patientID, &patientName, &patientAvatar, &patientRole,
			&doctorUserID, &doctorName, &doctorAvatar, &doctorRole); err != nil {
			s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch contacts.")
			return
		}
		otherID, otherName, otherAvatar, otherRole := doctorUserID, doctorName, doctorAvatar, doctorRole
		if patientID != user.ID {
			otherID, otherName, otherAvatar, otherRole = patientID, patientName, patientAvatar, patientRole
		}
		if otherID == user.ID || seen[otherID] {
			continue
		}
		seen[otherID] = true
		name := ""
		if otherName.Valid {
			name = otherName.String
		}
		list = append(list, map[string]any{
			"id":     otherID,
			"name":   name,
			"avatar": strPtr(otherAvatar),
			"role":   otherRole,
		})
	}
	if err := rows.Err(); err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch contacts.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": list})
}

// -------------------- GET /messages/:userId/messages --------------------

func (s *Server) handleMsgThread(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	otherUserID, ok := s.msgUUIDParam(w, r, "userId")
	if !ok {
		return
	}
	query := r.URL.Query()
	limit := 50
	if vals, present := query["limit"]; present {
		raw := ""
		if len(vals) > 0 {
			raw = vals[0]
		}
		if !msgDigitsOnly(raw) {
			s.validationFail(w, "query.limit", `Invalid string: must match pattern /^\d+$/`)
			return
		}
		if parsed, parsedOK := msgJsParseInt(raw); parsedOK {
			limit = parsed
		}
		if limit == 0 {
			limit = 50
		}
	}
	before := ""
	if vals, present := query["before"]; present {
		raw := ""
		if len(vals) > 0 {
			raw = vals[0]
		}
		if !msgIsUUID7(raw) {
			s.validationFail(w, "query.before", "Invalid id")
			return
		}
		before = raw
	}

	allowed, err := s.msgCanChat(r.Context(), user.ID, otherUserID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusForbidden, "Failed to fetch messages.")
		return
	}
	if !allowed {
		s.Fail(w, http.StatusBadRequest, "You can only chat with users you share a confirmed or completed appointment with")
		return
	}

	take := limit
	if take > 100 {
		take = 100
	}
	if take < 1 {
		take = 1
	}

	sqlText := "SELECT " + msgRowColumns + " FROM `Message` " +
		"WHERE ((senderId = ? AND receiverId = ?) OR (senderId = ? AND receiverId = ?))"
	args := []any{user.ID, otherUserID, otherUserID, user.ID}
	if before != "" {
		sqlText += " AND id < ?"
		args = append(args, before)
	}
	sqlText += " ORDER BY id DESC LIMIT ?"
	args = append(args, take)

	rows, err := s.DB.QueryContext(r.Context(), sqlText, args...)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusForbidden, "Failed to fetch messages.")
		return
	}
	var items []msgRow
	for rows.Next() {
		m, err := scanMsgRow(rows.Scan)
		if err != nil {
			rows.Close()
			s.msgRespondError(w, r, err, http.StatusForbidden, "Failed to fetch messages.")
			return
		}
		items = append(items, m)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.msgRespondError(w, r, err, http.StatusForbidden, "Failed to fetch messages.")
		return
	}
	rows.Close()

	// Mark incoming messages read (read receipts). The cursor is the newest
	// message of this page, matching `messages[0].id` in the service.
	now := time.Now().UTC()
	res, err := s.DB.ExecContext(r.Context(),
		"UPDATE `Message` SET isRead = TRUE, readAt = ? WHERE senderId = ? AND receiverId = ? AND isRead = FALSE",
		now, otherUserID, user.ID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusForbidden, "Failed to fetch messages.")
		return
	}
	if count, _ := res.RowsAffected(); count > 0 && len(items) > 0 {
		s.msgPublish(otherUserID, "message:read", map[string]any{
			"byUserId": user.ID,
			"upToId":   items[0].ID,
		})
	}

	// Read auditing: the subject is the other participant, whose words the
	// caller just opened.
	s.audit(r.Context(), "clinical.read", &user.ID, ptr("Message"), nil, map[string]any{
		"subjectId":     otherUserID,
		"via":           fmt.Sprintf("GET /api/messages/%s/messages", otherUserID),
		"messages":      len(items),
		"counterpartId": otherUserID,
	})

	list := make([]map[string]any, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- {
		list = append(list, msgRowJSON(&items[i], true))
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": list})
}

// -------------------- POST /messages/:userId/typing --------------------

func (s *Server) handleMsgTyping(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	receiverID, ok := s.msgUUIDParam(w, r, "userId")
	if !ok {
		return
	}
	_, fields, ok := s.msgBodyFields(w, r)
	if !ok {
		return
	}
	isTyping := false
	if raw, present := fields["isTyping"]; present {
		isTyping, ok = s.msgValidateBool(w, "body.isTyping", raw)
		if !ok {
			return
		}
	} else {
		s.validationFail(w, "body.isTyping", "Invalid input: expected boolean, received undefined")
		return
	}

	if user.ID == receiverID {
		s.Fail(w, http.StatusBadRequest, "Cannot message yourself")
		return
	}
	allowed, err := s.msgCanChat(r.Context(), user.ID, receiverID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send typing indicator.")
		return
	}
	if !allowed {
		s.Fail(w, http.StatusBadRequest, "You can only chat with users you share a confirmed or completed appointment with")
		return
	}

	eventType := "typing:stop"
	if isTyping {
		eventType = "typing:start"
	}
	s.msgPublish(receiverID, eventType, map[string]any{"userId": user.ID})
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

// -------------------- POST /messages/:userId (send) --------------------

type msgAttachmentPayload struct {
	URL  string
	Type string
}

var msgReactionAllowlist = map[string]bool{
	"👍": true, "❤️": true, "😂": true, "😮": true, "😢": true, "🙏": true,
}

// msgIsPlatformAttachment is the message schema's attachment URL refinement:
// a local /uploads/ path this server serves itself, or an https URL under the
// configured S3 public base (S3 itself is not ported, but the schema keeps the
// same gate against attacker-controlled URLs).
func msgIsPlatformAttachment(value string) bool {
	if strings.HasPrefix(value, "/uploads/") {
		if strings.Contains(value, "..") || strings.Contains(value, "\\") {
			return false
		}
		for _, r := range value {
			// JS `[\x00-\x1F\s]`: control characters, Unicode whitespace and
			// the BOM that JavaScript's \s also covers.
			if r <= 0x1F || r == 0xFEFF || unicode.IsSpace(r) {
				return false
			}
		}
		return true
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	base := strings.TrimSpace(os.Getenv("S3_PUBLIC_URL"))
	if base == "" {
		return false
	}
	baseURL, err := url.Parse(base)
	if err != nil || baseURL.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Host, baseURL.Host) &&
		strings.Contains(strings.ToLower(parsed.Path), "/avatars/")
}

func (s *Server) msgValidateAttachment(w http.ResponseWriter, raw json.RawMessage) (*msgAttachmentPayload, bool) {
	valueType := msgJSONTypeName(raw)
	if valueType != "object" {
		s.validationFail(w, "body.attachment", "Invalid input: expected object, received "+valueType)
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		s.validationFail(w, "body.attachment", "Invalid input: expected object, received object")
		return nil, false
	}
	urlRaw, present := fields["url"]
	if !present {
		s.validationFail(w, "body.attachment.url", "Invalid input: expected string, received undefined")
		return nil, false
	}
	attachmentURL, ok := s.msgValidateString(w, "body.attachment.url", urlRaw)
	if !ok {
		return nil, false
	}
	if len(attachmentURL) > 500 {
		s.validationFail(w, "body.attachment.url", "Too big: expected string to have <=500 characters")
		return nil, false
	}
	if !msgIsPlatformAttachment(attachmentURL) {
		s.validationFail(w, "body.attachment.url", "Attachment must reference a file uploaded through this platform")
		return nil, false
	}
	typeRaw, present := fields["type"]
	if !present {
		s.validationFail(w, "body.attachment.type", `Invalid option: expected one of "image"|"file"`)
		return nil, false
	}
	attachmentType, ok := s.msgValidateString(w, "body.attachment.type", typeRaw)
	if !ok {
		return nil, false
	}
	if attachmentType != "image" && attachmentType != "file" {
		s.validationFail(w, "body.attachment.type", `Invalid option: expected one of "image"|"file"`)
		return nil, false
	}
	return &msgAttachmentPayload{URL: attachmentURL, Type: attachmentType}, true
}

// msgJSName renders a nullable name the way a JS template literal would.
func msgJSName(name sql.NullString) string {
	if !name.Valid {
		return "null"
	}
	return name.String
}

func (s *Server) handleMsgSend(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	// Schema order is body then params, so body issues are reported first.
	_, fields, ok := s.msgBodyFields(w, r)
	if !ok {
		return
	}
	receiverID, ok := s.msgUUIDParam(w, r, "userId")
	if !ok {
		return
	}

	content := ""
	if raw, present := fields["content"]; present {
		if msgJSONTypeName(raw) != "string" {
			s.validationFail(w, "body.content", "Invalid input: expected string, received "+msgJSONTypeName(raw))
			return
		}
		var parsed string
		if err := json.Unmarshal(raw, &parsed); err != nil {
			s.validationFail(w, "body.content", "Invalid input: expected string, received string")
			return
		}
		if len(parsed) > 4000 {
			s.validationFail(w, "body.content", "Message too long")
			return
		}
		content = parsed
	}
	var attachment *msgAttachmentPayload
	if raw, present := fields["attachment"]; present {
		attachment, ok = s.msgValidateAttachment(w, raw)
		if !ok {
			return
		}
	}

	if user.ID == receiverID {
		s.Fail(w, http.StatusBadRequest, "Cannot message yourself")
		return
	}

	var receiverExists int
	err := s.DB.QueryRowContext(r.Context(), "SELECT 1 FROM `User` WHERE id = ? LIMIT 1", receiverID).Scan(&receiverExists)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "User not found")
		return
	}
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send message.")
		return
	}

	allowed, err := s.msgCanChat(r.Context(), user.ID, receiverID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send message.")
		return
	}
	if !allowed {
		s.Fail(w, http.StatusBadRequest, "You can only chat with users you share a confirmed or completed appointment with")
		return
	}

	var senderName, senderAvatar sql.NullString
	if err := s.DB.QueryRowContext(r.Context(), "SELECT name, avatar FROM `User` WHERE id = ?", user.ID).
		Scan(&senderName, &senderAvatar); err != nil && err != sql.ErrNoRows {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send message.")
		return
	}

	sanitized := s.msgSanitize(content)
	messageID := newID()
	createdAt := time.Now().UTC()
	var attachmentURL, attachmentType any
	if attachment != nil {
		attachmentURL = attachment.URL
		attachmentType = attachment.Type
	}
	_, err = s.DB.ExecContext(r.Context(),
		"INSERT INTO `Message` (id, content, senderId, receiverId, isRead, attachmentUrl, attachmentType, createdAt) "+
			"VALUES (?,?,?,?,?,?,?,?)",
		messageID, sanitized, user.ID, receiverID, false, attachmentURL, attachmentType, createdAt)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send message.")
		return
	}

	// In-app notification with the receiver's per-channel preference gate; the
	// email copy is accepted by the schema but not delivered yet (no mailer in
	// the Go service - noted, not silently dropped).
	receiverPrefs, err := s.notifGetPrefs(r.Context(), receiverID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send message.")
		return
	}
	wantsEmail := receiverPrefs.Message.Email
	notifBody := "You have a new message from " + msgJSName(senderName) + "."
	if attachment != nil {
		notifBody = msgJSName(senderName) + " sent you an attachment."
	}
	if _, err := s.notifCreate(r.Context(), receiverID, "New message", notifBody, "message", wantsEmail); err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to send message.")
		return
	}

	s.msgPublish(receiverID, "message:new", map[string]any{
		"message": map[string]any{
			"id":             messageID,
			"content":        sanitized,
			"attachmentUrl":  attachmentURL,
			"attachmentType": attachmentType,
			"senderId":       user.ID,
			"receiverId":     receiverID,
			"createdAt":      jsTimeValue(createdAt),
		},
	})

	// Crisis triage is deliberately off the request path: a failure to detect
	// must never fail or delay the send.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.msgRaiseMessageRisk(ctx, messageID, user.ID, sanitized); err != nil {
			s.Log.Error("crisis triage on outgoing message failed", "err", err)
		}
	}()

	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{
		"id":             messageID,
		"content":        sanitized,
		"senderId":       user.ID,
		"receiverId":     receiverID,
		"isRead":         false,
		"readAt":         nil,
		"attachmentUrl":  attachmentURL,
		"attachmentType": attachmentType,
		"deletedAt":      nil,
		"reaction":       nil,
		"createdAt":      jsTimeValue(createdAt),
		"sender": map[string]any{
			"id":     user.ID,
			"name":   strPtr(senderName),
			"avatar": strPtr(senderAvatar),
		},
	}})
}

// -------------------- DELETE /messages/:id --------------------

func (s *Server) handleMsgDelete(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	messageID, ok := s.msgUUIDParam(w, r, "id")
	if !ok {
		return
	}

	var senderID, receiverID string
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT senderId, receiverId FROM `Message` WHERE id = ?", messageID).Scan(&senderID, &receiverID)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Message not found")
		return
	}
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to delete message.")
		return
	}
	if senderID != user.ID {
		s.Fail(w, http.StatusForbidden, "you can only delete your own messages")
		return
	}

	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `Message` SET deletedAt = ? WHERE id = ?", time.Now().UTC(), messageID); err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to delete message.")
		return
	}

	s.msgPublish(receiverID, "message:deleted", map[string]any{
		"messageId": messageID,
		"byUserId":  user.ID,
	})
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

// -------------------- PUT /messages/:id/reaction --------------------

func (s *Server) handleMsgReaction(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	messageID, ok := s.msgUUIDParam(w, r, "id")
	if !ok {
		return
	}
	_, fields, ok := s.msgBodyFields(w, r)
	if !ok {
		return
	}
	raw, present := fields["reaction"]
	if !present {
		s.validationFail(w, "body.reaction", "Invalid input")
		return
	}
	var reaction *string
	switch msgJSONTypeName(raw) {
	case "null":
		reaction = nil
	case "string":
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			s.validationFail(w, "body.reaction", "Invalid input")
			return
		}
		if !msgReactionAllowlist[value] {
			s.validationFail(w, "body.reaction", "Invalid input")
			return
		}
		reaction = &value
	default:
		s.validationFail(w, "body.reaction", "Invalid input")
		return
	}

	m, err := scanMsgRow(s.DB.QueryRowContext(r.Context(),
		"SELECT "+msgRowColumns+" FROM `Message` WHERE id = ?", messageID).Scan)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Message not found")
		return
	}
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to update reaction.")
		return
	}
	if m.DeletedAt.Valid {
		s.Fail(w, http.StatusNotFound, "Message not found")
		return
	}
	if m.SenderID != user.ID && m.ReceiverID != user.ID {
		s.Fail(w, http.StatusForbidden, "not a participant of this conversation")
		return
	}

	var reactionValue any
	if reaction != nil {
		reactionValue = *reaction
	}
	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `Message` SET reaction = ? WHERE id = ?", reactionValue, messageID); err != nil {
		s.msgRespondError(w, r, err, http.StatusBadRequest, "Failed to update reaction.")
		return
	}

	otherID := m.SenderID
	if m.SenderID == user.ID {
		otherID = m.ReceiverID
	}
	s.msgPublish(otherID, "message:reacted", map[string]any{
		"messageId": messageID,
		"reaction":  reactionValue,
		"byUserId":  user.ID,
	})

	m.Reaction = sql.NullString{}
	if reaction != nil {
		m.Reaction = sql.NullString{String: *reaction, Valid: true}
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": msgRowJSON(&m, false)})
}

// -------------------- POST /messages/upload --------------------

type msgUpload struct {
	receiverID   string
	data         []byte
	originalName string
	mimeType     string
	hasFile      bool
}

var msgAllowedExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true,
	".pdf": true, ".doc": true, ".docx": true, ".txt": true,
}

func msgUploadFilterAllows(extension, mimeType string) bool {
	if !msgAllowedExtensions[extension] {
		return false
	}
	return strings.HasPrefix(mimeType, "image/") ||
		strings.HasPrefix(mimeType, "application/") ||
		mimeType == "text/plain"
}

// msgReadUpload consumes the multipart body with multer's limits:
// fileSize 5MB, fieldSize 64KB, fields 8, files 1, parts 9 - and multer's
// error messages, which the Node error middleware discloses verbatim.
func (s *Server) msgReadUpload(r *http.Request) (*msgUpload, string) {
	upload := &msgUpload{}
	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		// multer skips non-multipart requests; express.json has already parsed
		// a JSON body, so receiverId still works and the controller reports the
		// missing file itself.
		raw, _ := io.ReadAll(r.Body)
		trimmed := strings.TrimSpace(string(raw))
		if trimmed != "" {
			var fields map[string]json.RawMessage
			if json.Unmarshal([]byte(trimmed), &fields) == nil {
				if rawReceiver, ok := fields["receiverId"]; ok {
					var value string
					if json.Unmarshal(rawReceiver, &value) == nil {
						upload.receiverID = strings.TrimSpace(value)
					}
				}
			}
		}
		return upload, ""
	}

	reader, err := r.MultipartReader()
	if err != nil {
		return nil, "Multipart: Boundary not found"
	}
	parts, fields, files := 0, 0, 0
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return nil, "File too large"
			}
			return nil, "Multipart: Boundary not found"
		}
		parts++
		if parts > 9 {
			return nil, "Too many parts"
		}
		fieldName := part.FormName()
		fileName := part.FileName()
		if fileName == "" {
			fields++
			if fields > 8 {
				return nil, "Too many fields"
			}
			if len(fieldName) > 100 {
				return nil, "Field name too long"
			}
			value, err := io.ReadAll(io.LimitReader(part, 64*1024+1))
			part.Close()
			if err != nil {
				var maxErr *http.MaxBytesError
				if errors.As(err, &maxErr) {
					return nil, "Field value too long"
				}
				return nil, "Unexpected end of form"
			}
			if len(value) > 64*1024 {
				return nil, "Field value too long"
			}
			if fieldName == "receiverId" {
				upload.receiverID = strings.TrimSpace(string(value))
			}
			continue
		}

		files++
		if files > 1 {
			part.Close()
			return nil, "Too many files"
		}
		if fieldName != "file" {
			part.Close()
			return nil, "Unexpected field"
		}
		extension := strings.ToLower(filepath.Ext(fileName))
		mimeType := part.Header.Get("Content-Type")
		if !msgUploadFilterAllows(extension, mimeType) {
			part.Close()
			return nil, "File type not allowed (images, PDF, DOC, TXT up to 5MB)."
		}
		data, err := io.ReadAll(io.LimitReader(part, 5*1024*1024+1))
		part.Close()
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return nil, "File too large"
			}
			return nil, "File too large"
		}
		if len(data) > 5*1024*1024 {
			return nil, "File too large"
		}
		upload.data = data
		upload.originalName = fileName
		upload.mimeType = mimeType
		upload.hasFile = true
	}
	return upload, ""
}

// msgSaveUpload mints a UUIDv7 file name with the sanitised original
// extension, then hands it to the storage layer: S3 when configured, the local
// uploads directory otherwise.
func (s *Server) msgSaveUpload(ctx context.Context, data []byte, originalName string) (string, error) {
	extension := strings.ToLower(filepath.Ext(originalName))
	cleaned := make([]rune, 0, len(extension))
	for _, r := range extension {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' {
			cleaned = append(cleaned, r)
		}
	}
	extension = string(cleaned)
	if extension == "" {
		extension = ".jpg"
	}
	name := newID() + extension
	return s.saveUpload(ctx, name, data)
}

func (s *Server) handleMsgUpload(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	upload, limitError := s.msgReadUpload(r)
	if limitError != "" {
		s.Fail(w, http.StatusBadRequest, limitError)
		return
	}
	if upload.receiverID == "" {
		s.Fail(w, http.StatusBadRequest, "receiverId is required")
		return
	}
	allowed, err := s.msgCanChat(r.Context(), user.ID, upload.receiverID)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to upload attachment.")
		return
	}
	if !allowed {
		s.Fail(w, http.StatusForbidden, "You can only upload attachments for users you share a confirmed or completed appointment with")
		return
	}
	if !upload.hasFile {
		s.Fail(w, http.StatusBadRequest, "No file provided")
		return
	}
	fileURL, err := s.msgSaveUpload(r.Context(), upload.data, upload.originalName)
	if err != nil {
		s.msgRespondError(w, r, err, http.StatusInternalServerError, "Failed to upload attachment.")
		return
	}
	fileType := "file"
	if strings.HasPrefix(upload.mimeType, "image/") {
		fileType = "image"
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{
		"url":  fileURL,
		"type": fileType,
	}})
}

// -------------------- crisis triage (crisisText + clinicalSafety) --------------------

type msgRiskSignal struct {
	Level              string
	MatchedText        string
	MentionsThirdParty bool
	Reason             string
}

var msgCrisisPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)suicid(e|al|ally)`),
	regexp.MustCompile(`(?i)kill(ing)? myself`),
	regexp.MustCompile(`(?i)end(ing)? my life`),
	regexp.MustCompile(`(?i)want(ing)? to die`),
	regexp.MustCompile(`(?i)don'?t want to (be here|live|go on)`),
	regexp.MustCompile(`(?i)self[\s-]?harm`),
	regexp.MustCompile(`(?i)hurt(ing)? myself`),
	regexp.MustCompile(`(?i)harm(ing)? myself`),
	regexp.MustCompile(`(?i)overdos(e|ing)`),
	regexp.MustCompile(`(?i)bunuh diri`),
	regexp.MustCompile(`(?i)mengakhiri hidup`),
	regexp.MustCompile(`(?i)mau ingin mati`),
	regexp.MustCompile(`(?i)ingin mati`),
	regexp.MustCompile(`(?i)menyakiti diri`),
	regexp.MustCompile(`(?i)sakiti diri`),
}

var msgThirdPartyPattern = regexp.MustCompile(`(?i)\b(my (friend|brother|sister|partner|husband|wife|son|daughter|mother|father|roommate|colleague|coworker|boss))\b`)

// msgDetectFreeTextRisk ports detectFreeTextRisk: a deterministic keyword
// match, never a model call, and a third-party mention informs rather than
// suppresses.
func msgDetectFreeTextRisk(content string) *msgRiskSignal {
	if content == "" {
		return nil
	}
	for _, pattern := range msgCrisisPatterns {
		location := pattern.FindStringIndex(content)
		if location == nil {
			continue
		}
		matched := content[location[0]:location[1]]
		mentionsThirdParty := msgThirdPartyPattern.MatchString(content)
		context := ""
		if mentionsThirdParty {
			context = " The message also mentions another person, so it may partly be about them rather than about the patient; the clinician decides which."
		}
		return &msgRiskSignal{
			Level:              "urgent",
			MatchedText:        matched,
			MentionsThirdParty: mentionsThirdParty,
			Reason: fmt.Sprintf(
				"Free-text message matched the crisis pattern %q. This is a keyword match, not a clinical assessment - it is a prompt for a clinician to read the message and decide.%s",
				matched, context),
		}
	}
	return nil
}

type msgRiskAlertInput struct {
	UserID     string
	UserName   string
	Level      string
	Reason     string
	SourceType string
	SourceID   string
}

// msgRaiseMessageRisk mirrors MessageService.raiseMessageRisk: only a
// patient's own words can page anyone; a clinician's clinical language must
// not.
func (s *Server) msgRaiseMessageRisk(ctx context.Context, messageID, senderID, content string) error {
	var name sql.NullString
	var role string
	err := s.DB.QueryRowContext(ctx, "SELECT name, role FROM `User` WHERE id = ?", senderID).Scan(&name, &role)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if role != "patient" {
		return nil
	}
	signal := msgDetectFreeTextRisk(content)
	if signal == nil {
		return nil
	}
	s.msgRaiseRiskAlert(ctx, msgRiskAlertInput{
		UserID:     senderID,
		UserName:   strValue(name),
		Level:      signal.Level,
		Reason:     signal.Reason,
		SourceType: "message",
		SourceID:   messageID,
	})
	return nil
}

// msgRaiseRiskAlert ports clinicalSafety.raiseRiskAlert for the message path:
// record the disclosure, add it to the treating clinician's queue, and notify
// with every channel isolated so one failure cannot swallow the escalation.
func (s *Server) msgRaiseRiskAlert(ctx context.Context, input msgRiskAlertInput) {
	var assignedDoctor sql.NullString
	err := s.DB.QueryRowContext(ctx,
		"SELECT d.userId FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId "+
			"WHERE a.userId = ? AND a.status IN ('confirmed','completed') "+
			"ORDER BY a.appointmentDate DESC LIMIT 1",
		input.UserID).Scan(&assignedDoctor)
	hasAppointment := err == nil

	var sourceID any
	if input.SourceID != "" {
		sourceID = input.SourceID
	}
	var assigned any
	if assignedDoctor.Valid {
		assigned = assignedDoctor.String
	}
	alertID := newID()
	_, insertErr := s.DB.ExecContext(ctx,
		"INSERT INTO `RiskAlert` (id, userId, level, reason, sourceType, sourceId, assignedDoctorUserId, createdAt) "+
			"VALUES (?,?,?,?,?,?,?,?)",
		alertID, input.UserID, input.Level, input.Reason, input.SourceType, sourceID, assigned, time.Now().UTC())
	recorded := insertErr == nil
	if insertErr != nil {
		s.Log.Error("failed to persist risk alert", "err", insertErr, "userId", input.UserID)
	}

	if !hasAppointment {
		s.audit(ctx, "risk.raised", &input.UserID, nil, nil, map[string]any{
			"level":             input.Level,
			"sourceType":        input.SourceType,
			"clinicianNotified": false,
			"recorded":          recorded,
		})
		s.Log.Warn("risk disclosure with no assigned clinician", "userId", input.UserID, "level", input.Level)
		return
	}

	doctorUserID := assignedDoctor.String
	name := input.UserName
	if name == "" {
		name = "A patient"
	}

	clinicianReached := false
	title := "Risk disclosure from a patient"
	if input.Level == "urgent" {
		title = "Urgent risk disclosure from a patient"
	}
	if _, err := s.notifCreate(ctx, doctorUserID, title,
		fmt.Sprintf("%s reported thoughts of self-harm or death on a screening questionnaire (%s). Please reach out to them today.", name, input.Level),
		"system", true); err != nil {
		s.Log.Error("risk escalation channel failed", "err", err, "channel", "inapp", "userId", input.UserID)
	} else {
		clinicianReached = true
	}

	var alertRef any
	if recorded {
		alertRef = alertID
	}
	s.msgPublish(doctorUserID, "risk:alert", map[string]any{
		"patientName": name,
		"level":       input.Level,
		"alertId":     alertRef,
	})

	adminRows, err := s.DB.QueryContext(ctx,
		"SELECT id FROM `User` WHERE role = 'admin' AND isBanned = FALSE LIMIT 5")
	if err == nil {
		var adminIDs []string
		for adminRows.Next() {
			var adminID string
			if err := adminRows.Scan(&adminID); err != nil {
				break
			}
			adminIDs = append(adminIDs, adminID)
		}
		adminRows.Close()
		for _, adminID := range adminIDs {
			if _, err := s.notifCreate(ctx, adminID, "Risk disclosure awaiting review",
				fmt.Sprintf("%s disclosed thoughts of self-harm (%s) and has no clinician currently assigned.", name, input.Level),
				"system", false); err != nil {
				s.Log.Error("risk escalation channel failed", "err", err, "channel", "admin", "userId", input.UserID)
			}
		}
	}

	var targetID *string
	if recorded {
		targetID = &alertID
	}
	s.audit(ctx, "risk.raised", &input.UserID, ptr("RiskAlert"), targetID, map[string]any{
		"level":        input.Level,
		"sourceType":   input.SourceType,
		"doctorUserId": doctorUserID,
	})

	if clinicianReached && recorded {
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `RiskAlert` SET notifiedDoctorUserId = ? WHERE id = ?", doctorUserID, alertID); err != nil {
			s.Log.Warn("failed to mark risk alert as notified", "err", err, "alertId", alertID)
		}
	}
	if !recorded {
		s.Log.Error("risk disclosure escalated with no durable record", "userId", input.UserID, "level", input.Level, "clinicianReached", clinicianReached)
	}
}
