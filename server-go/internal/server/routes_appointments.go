package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

// registerAppointments is the port of server/src/routes/appointment.routes.ts.
// Every route is authenticated. Helpers here are shared with the follow-up and
// review files (one domain, one package); they are all prefixed appt/followUp/
// review so they cannot collide with another domain's file.
func (s *Server) registerAppointments(api chi.Router) {
	api.Group(func(api chi.Router) {
		api.Use(s.authenticate)
		api.Post("/appointments/book", s.handleApptBook)
		api.Get("/appointments/my", s.handleApptMy)
		api.Get("/appointments/{id}/rebook-options", s.handleApptRebookOptions)
		api.Get("/appointments/{id}/ics", s.handleApptICS)
		api.Post("/appointments/{id}/join", s.handleApptJoin)
		api.Put("/appointments/{id}/status", s.handleApptUpdateStatus)
		api.Put("/appointments/{id}/reschedule", s.handleApptReschedule)
	})
}

/* ------------------------------------------------------------------ *
 * Validation (schemas/appointment.schema.ts + schemas/params.schema.ts)
 * ------------------------------------------------------------------ */

var (
	apptUUID7Re  = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	apptISODayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	apptHHMMRe   = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	apptTimesRe  = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
)

func apptUUID7OK(v string) bool { return apptUUID7Re.MatchString(v) }

// apptISODayError mirrors the isoDay schema: a `YYYY-MM-DD` shape plus the
// `Date.parse` refine. V8 rolls day overflow within a month over (2026-02-30
// parses as March 2) and only returns NaN for a month above 12 or a day above
// 31, so those are the bounds checked.
func apptISODayError(v, label string) string {
	if !apptISODayRe.MatchString(v) {
		return label + " must be YYYY-MM-DD"
	}
	month, _ := strconv.Atoi(v[5:7])
	day, _ := strconv.Atoi(v[8:10])
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return label + " is not a real date"
	}
	return ""
}

func apptHHMMError(v, label string) string {
	if !apptHHMMRe.MatchString(v) {
		return label + " must be HH:mm in 24-hour time"
	}
	return ""
}

func apptEnumError(v string, allowed ...string) string {
	if containsString(allowed, v) {
		return ""
	}
	quoted := make([]string, len(allowed))
	for i, a := range allowed {
		quoted[i] = `"` + a + `"`
	}
	return "Invalid option: expected one of " + strings.Join(quoted, "|")
}

// apptDecodeBody decodes a JSON body without rejecting unknown keys: none of
// the appointment schemas is `.strict()`, so Zod strips unknown keys rather
// than failing. An absent body behaves like `{}`, as the validate middleware
// does for `req.body ?? {}`.
func apptDecodeBody(r *http.Request, v any) error {
	err := json.NewDecoder(r.Body).Decode(v)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (appt *apptBookBody) resolveType() string {
	if appt.ConsultationType != nil {
		return *appt.ConsultationType
	}
	return "video"
}

/* ------------------------------------------------------------------ *
 * Date helpers (lib/date.ts)
 * ------------------------------------------------------------------ */

// apptParseLocalDate: a calendar date is midnight in the server's own zone,
// which is UTC for both Prisma's storage and this service.
func apptParseLocalDate(value string) time.Time {
	m := apptISODayRe.FindStringSubmatch(value)
	if m == nil {
		return time.Time{}
	}
	y, _ := strconv.Atoi(value[0:4])
	mo, _ := strconv.Atoi(value[5:7])
	d, _ := strconv.Atoi(value[8:10])
	return time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
}

// apptLocalDateKey ports lib/date.ts's localDateKey: the calendar date in the
// server's configured timezone (TZ=Asia/Jakarta in every deployment), not the
// UTC date. The slot/date equality check is built on this, and a UTC day made
// every slot whose 00:00 WIB start falls on the previous UTC day look like a
// different date than the one the client sent.
func apptLocalDateKey(t time.Time) string {
	loc, err := time.LoadLocation("Asia/Jakarta")
	if err != nil {
		loc = time.UTC
	}
	return t.In(loc).Format("2006-01-02")
}

// apptTimeToMinutes ports timeToMinutes: `"HH:mm"` (one or two hour digits) to
// minutes past midnight; hours above 24 or minutes above 59 are invalid.
func apptTimeToMinutes(v string) (int, bool) {
	m := apptTimesRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0, false
	}
	hours, _ := strconv.Atoi(m[1])
	minutes, _ := strconv.Atoi(m[2])
	if hours > 24 || minutes > 59 {
		return 0, false
	}
	return hours*60 + minutes, true
}

func apptHM(startTime *string) (int, int) {
	raw := "00:00"
	if startTime != nil && *startTime != "" {
		raw = *startTime
	}
	mins, ok := apptTimeToMinutes(raw)
	if !ok {
		return 0, 0
	}
	return mins / 60, mins % 60
}

func apptOverlap(aStart, aEnd, bStart, bEnd int) bool {
	return aStart < bEnd && bStart < aEnd
}

func apptResolveTimezone(tz *string) *time.Location {
	if tz != nil && strings.TrimSpace(*tz) != "" {
		if loc, err := time.LoadLocation(strings.TrimSpace(*tz)); err == nil {
			return loc
		}
	}
	if loc, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		return loc
	}
	return time.UTC
}

// apptZonedDayStart: the instant the given calendar day begins in loc.
func apptZonedDayStart(key string, loc *time.Location) time.Time {
	t, err := time.ParseInLocation("2006-01-02", key, time.UTC)
	if err != nil {
		return time.Time{}
	}
	y, mo, d := t.Date()
	return time.Date(y, mo, d, 0, 0, 0, 0, loc)
}

// apptFormatUS is `toLocaleDateString()` under the en-US default.
func apptFormatUS(t time.Time) string { return t.UTC().Format("1/2/2006") }

// apptFormatGB is `toLocaleDateString("en-GB")`.
func apptFormatGB(t time.Time) string { return t.UTC().Format("02/01/2006") }

func apptStrOr(p *string, fallback string) string {
	if p == nil || *p == "" {
		return fallback
	}
	return *p
}

/* ------------------------------------------------------------------ *
 * Misc helpers
 * ------------------------------------------------------------------ */

func apptHex(n int) string {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand does not fail in practice; a zero-filled value would be
		// a weak room name, so fall back to a time-derived one instead.
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func (s *Server) apptSanitizeText(input string) string {
	clean := s.Sanitizer.Sanitize(strings.TrimSpace(input))
	runes := []rune(clean)
	if len(runes) > 4000 {
		return string(runes[:4000])
	}
	return clean
}

// apptSanitizeClip is sanitize(...).slice(0, max) from utils/sanitize.ts call
// sites that bound a field after cleaning it.
func (s *Server) apptSanitizeClip(input string, max int) string {
	clean := s.apptSanitizeText(input)
	runes := []rune(clean)
	if len(runes) > max {
		return string(runes[:max])
	}
	return clean
}

// apptClampInt mirrors the review controller's clampInt: a non-finite parse
// falls back, then the value is truncated and clamped to [min, max].
func apptClampInt(raw string, fallback, minV, maxV int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return fallback
	}
	if f > 1e9 {
		return maxV
	}
	if f < -1e9 {
		return minV
	}
	v := int(f)
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

// apptPageParam mirrors `parseInt(query) || fallback`.
func apptPageParam(raw string, fallback int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return fallback
	}
	if f == 0 {
		return fallback
	}
	if f > 1e9 {
		return 1e9
	}
	if f < -1e9 {
		return -1e9
	}
	return int(f)
}

// apptControllerErr maps a service failure to a response the way the Node
// controller does: a typed AppError keeps its status and message, anything
// else is logged and becomes the controller's fixed fallback.
func (s *Server) apptControllerErr(w http.ResponseWriter, r *http.Request, err error, fallbackStatus int, fallbackMsg string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("appointment handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, fallbackStatus, fallbackMsg)
}

// apptControllerErrFixed preserves the message of a typed error but always
// uses the controller's own status (getMy and getIcs hard-code 500).
func (s *Server) apptControllerErrFixed(w http.ResponseWriter, r *http.Request, err error, status int, fallbackMsg string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, status, appErr.Message)
		return
	}
	s.Log.Error("appointment handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, status, fallbackMsg)
}

/* ------------------------------------------------------------------ *
 * Notifications (NotificationService.create + realtime publishEvent)
 * ------------------------------------------------------------------ */

const apptEventsChannel = "mindease:events"

type apptPrefs struct {
	inApp bool
	email bool
}

var apptDefaultPrefs = map[string]apptPrefs{
	"appointment": {inApp: true, email: false},
	"message":     {inApp: true, email: false},
	"system":      {inApp: true, email: true},
}

func apptPrefsFor(raw sql.NullString, notifType string) apptPrefs {
	prefs := apptDefaultPrefs[notifType]
	if !raw.Valid || raw.String == "" {
		return prefs
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(raw.String), &parsed) != nil {
		return prefs
	}
	value, ok := parsed[notifType]
	if !ok {
		return prefs
	}
	switch v := value.(type) {
	case bool:
		// Backward-compatible shape: `{ appointment: bool }` sets inApp only.
		prefs.inApp = v
	case map[string]any:
		if b, ok := v["inApp"].(bool); ok {
			prefs.inApp = b
		}
		if b, ok := v["email"].(bool); ok {
			prefs.email = b
		}
	}
	return prefs
}

// apptNotify ports NotificationService.create's in-app branch. The email and
// web-push channels are not ported (no mailer/push service in this binary), so
// a user who disabled in-app for a category receives nothing here. The stored
// title and message go through the sanitizer exactly once, at this choke
// point, like the Node service does.
func (s *Server) apptNotify(ctx context.Context, userID, title, message, notifType string) {
	if _, known := apptDefaultPrefs[notifType]; !known {
		// NotificationService.create stores nothing for a type outside
		// PREFS_TYPES: `!prefs[type]?.inApp` is true when prefs[type] is absent.
		return
	}
	var raw sql.NullString
	prefs := apptDefaultPrefs[notifType]
	if err := s.DB.QueryRowContext(ctx, "SELECT notificationPrefs FROM `User` WHERE id = ?", userID).Scan(&raw); err == nil {
		prefs = apptPrefsFor(raw, notifType)
	}
	if !prefs.inApp {
		return
	}

	title = s.apptSanitizeText(title)
	message = s.apptSanitizeText(message)
	now := time.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), userID, title, message, false, notifType, now)
	if err != nil {
		s.Log.Warn("notification insert failed", "userId", userID, "err", err)
		return
	}
	s.apptPublish(userID, "notification:new", map[string]any{
		"title": title, "message": message, "type": notifType, "createdAt": nowISO(),
	})
	s.pushSend(ctx, userID, title, message, "/dashboard")
}

// apptPublish sends a realtime event on the shared channel the Go realtime
// service subscribes to. Best-effort, like publishEvent.
func (s *Server) apptPublish(userID, eventType string, payload map[string]any) {
	if s.Cfg.IsTest || s.Redis == nil {
		return
	}
	body, err := json.Marshal(map[string]any{"userId": userID, "type": eventType, "payload": payload})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Redis.Publish(ctx, apptEventsChannel, string(body)).Err(); err != nil {
		s.Log.Warn("failed to publish realtime event", "type", eventType, "err", err)
	}
}

/* ------------------------------------------------------------------ *
 * Waitlist (waitlist.service.ts, the two methods bookings call)
 * ------------------------------------------------------------------ */

func (s *Server) apptWaitlistMarkBooked(ctx context.Context, doctorID, patientID string) {
	_, err := s.DB.ExecContext(ctx,
		"UPDATE `WaitlistEntry` SET status = 'booked' WHERE doctorId = ? AND patientId = ? AND status IN ('waiting','notified')",
		doctorID, patientID)
	if err != nil {
		s.Log.Warn("waitlist markBooked failed", "err", err)
	}
}

func (s *Server) apptWaitlistNotify(ctx context.Context, doctorID string) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, patientId FROM `WaitlistEntry` WHERE doctorId = ? AND status = 'waiting' ORDER BY createdAt ASC LIMIT 3", doctorID)
	if err != nil {
		s.Log.Warn("waitlist notify query failed", "err", err)
		return
	}
	type waiter struct{ id, patientID string }
	var waiters []waiter
	for rows.Next() {
		var w waiter
		if err := rows.Scan(&w.id, &w.patientID); err != nil {
			rows.Close()
			s.Log.Warn("waitlist scan failed", "err", err)
			return
		}
		waiters = append(waiters, w)
	}
	rows.Close()

	for _, w := range waiters {
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `WaitlistEntry` SET status = 'notified', notifiedAt = ? WHERE id = ? AND status = 'waiting'",
			time.Now().UTC(), w.id)
		if err != nil {
			continue
		}
		if n, _ := res.RowsAffected(); n != 1 {
			continue
		}
		s.apptNotify(ctx, w.patientID, "A slot just opened",
			"One of your waitlisted psychologists just opened a new slot. Book it before it's gone!", "appointment")
	}
}

/* ------------------------------------------------------------------ *
 * Video grants (video.service.ts)
 * ------------------------------------------------------------------ */

type apptProviderState struct {
	provider string
	degraded bool
	reason   string
}

const apptVideoTokenMaxTTLSeconds = 6 * 60 * 60

func (s *Server) apptActiveProvider() apptProviderState {
	if s.Cfg.VideoProvider == "livekit" {
		if s.Cfg.LiveKitURL == "" || s.Cfg.LiveKitKey == "" || s.Cfg.LiveKitSecret == "" {
			return apptProviderState{
				provider: "jitsi",
				degraded: true,
				reason:   "VIDEO_PROVIDER=livekit but LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not all set",
			}
		}
		return apptProviderState{provider: "livekit"}
	}
	return apptProviderState{provider: "jitsi"}
}

// apptMintLiveKitToken is the hand-rolled HS256 LiveKit access token: iss is
// the API key, sub the user id, and the `video` claim is scoped to exactly one
// room. The secret signs and never appears in the payload.
func (s *Server) apptMintLiveKitToken(userID, displayName, roomName string, validUntilMs int64) (string, error) {
	nowSeconds := time.Now().Unix()
	expiresAt := validUntilMs / 1000
	if capAt := nowSeconds + apptVideoTokenMaxTTLSeconds; expiresAt > capAt {
		expiresAt = capAt
	}
	if expiresAt <= nowSeconds {
		return "", BadRequest("Video token window has already closed")
	}
	claims := jwt.MapClaims{
		"iss":  s.Cfg.LiveKitKey,
		"sub":  userID,
		"nbf":  nowSeconds,
		"iat":  nowSeconds,
		"jti":  apptHex(12),
		"name": displayName,
		"video": map[string]any{
			"room":           roomName,
			"roomJoin":       true,
			"canPublish":     true,
			"canSubscribe":   true,
			"canPublishData": true,
		},
		"exp": expiresAt,
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(s.Cfg.LiveKitSecret))
}

type apptVideoGrant struct {
	provider    string
	room        string
	token       *string
	identity    string
	displayName string
}

func apptRoomNameFor(appointmentID, seed string) string {
	return "mindease-" + appointmentID + "-" + seed
}

func apptJitsiRoom(appointmentID string) string {
	return "https://meet.jit.si/MindEase-" + appointmentID + "-" + apptHex(8)
}

func (s *Server) apptBuildGrant(appointmentID, userID, displayName, roomSeed string, validUntilMs int64) (apptVideoGrant, error) {
	state := s.apptActiveProvider()
	if state.provider == "livekit" {
		roomName := apptRoomNameFor(appointmentID, roomSeed)
		token, err := s.apptMintLiveKitToken(userID, displayName, roomName, validUntilMs)
		if err != nil {
			return apptVideoGrant{}, err
		}
		return apptVideoGrant{provider: "livekit", room: roomName, token: &token, identity: userID, displayName: displayName}, nil
	}
	if state.degraded {
		s.Log.Warn("falling back to the unauthenticated video provider; sessions are not end-to-end authenticated", "reason", state.reason)
	}
	return apptVideoGrant{provider: "jitsi", room: apptJitsiRoom(appointmentID), identity: userID, displayName: displayName}, nil
}

/* ------------------------------------------------------------------ *
 * Row scanning / JSON shaping
 * ------------------------------------------------------------------ */

const apptColumns = "id, userId, doctorId, slotId, appointmentDate, startTime, endTime, consultationType, status, " +
	"notes, meetingLink, roomSeed, idempotencyKey, reminderSentAt, checkinSentAt, packagePurchaseId, creditApplied, createdAt, updatedAt"

type apptRow struct {
	ID                string
	UserID            string
	DoctorID          string
	SlotID            *string
	AppointmentDate   time.Time
	StartTime         *string
	EndTime           *string
	ConsultationType  string
	Status            string
	Notes             *string
	MeetingLink       *string
	RoomSeed          *string
	IdempotencyKey    *string
	ReminderSentAt    *time.Time
	CheckinSentAt     *time.Time
	PackagePurchaseID *string
	CreditApplied     bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type apptScanner interface{ Scan(dest ...any) error }

func scanApptRow(sc apptScanner) (*apptRow, error) {
	var a apptRow
	err := sc.Scan(
		&a.ID, &a.UserID, &a.DoctorID, &a.SlotID, &a.AppointmentDate, &a.StartTime, &a.EndTime,
		&a.ConsultationType, &a.Status, &a.Notes, &a.MeetingLink, &a.RoomSeed, &a.IdempotencyKey,
		&a.ReminderSentAt, &a.CheckinSentAt, &a.PackagePurchaseID, &a.CreditApplied, &a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (a *apptRow) JSON() map[string]any {
	return map[string]any{
		"id":                a.ID,
		"userId":            a.UserID,
		"doctorId":          a.DoctorID,
		"slotId":            a.SlotID,
		"appointmentDate":   jsTimeValue(a.AppointmentDate),
		"startTime":         a.StartTime,
		"endTime":           a.EndTime,
		"consultationType":  a.ConsultationType,
		"status":            a.Status,
		"notes":             a.Notes,
		"meetingLink":       a.MeetingLink,
		"roomSeed":          a.RoomSeed,
		"idempotencyKey":    a.IdempotencyKey,
		"reminderSentAt":    jsTime(a.ReminderSentAt),
		"checkinSentAt":     jsTime(a.CheckinSentAt),
		"packagePurchaseId": a.PackagePurchaseID,
		"creditApplied":     a.CreditApplied,
		"createdAt":         jsTimeValue(a.CreatedAt),
		"updatedAt":         jsTimeValue(a.UpdatedAt),
	}
}

func (s *Server) apptByID(ctx context.Context, id string) (*apptRow, error) {
	row, err := scanApptRow(s.DB.QueryRowContext(ctx, "SELECT "+apptColumns+" FROM `Appointment` WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return nil, NotFound("Appointment not found")
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// apptDoctorAllowlist is the same field allowlist doctor.service.ts uses for
// the public profile: every Doctor scalar except the bank and license columns,
// plus a restricted user.
func (s *Server) apptDoctorAllowlist(ctx context.Context, doctorID string) (map[string]any, error) {
	var (
		id, specialty, bio, availability, verificationStatus string
		experience, totalReviews, price                      int
		rating                                               float64
		licenseNumber, licenseIssuer                         *string
		awayUntil                                            *time.Time
		userID                                               string
		name, avatar, phone                                  *string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT d.id, d.specialty, d.bio, d.experience, d.rating, d.totalReviews, d.price, d.availability, "+
			"d.verificationStatus, d.licenseNumber, d.licenseIssuer, d.awayUntil, u.id, u.name, u.avatar, u.phone_number "+
			"FROM `Doctor` d JOIN `User` u ON u.id = d.userId WHERE d.id = ?", doctorID).
		Scan(&id, &specialty, &bio, &experience, &rating, &totalReviews, &price, &availability,
			&verificationStatus, &licenseNumber, &licenseIssuer, &awayUntil, &userID, &name, &avatar, &phone)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id":                 id,
		"specialty":          specialty,
		"bio":                bio,
		"experience":         experience,
		"rating":             rating,
		"totalReviews":       totalReviews,
		"price":              price,
		"availability":       availability,
		"verificationStatus": verificationStatus,
		"licenseNumber":      licenseNumber,
		"licenseIssuer":      licenseIssuer,
		"awayUntil":          jsTime(awayUntil),
		"user": map[string]any{
			"id": userID, "name": name, "avatar": avatar, "phone_number": phone,
		},
	}, nil
}

// apptUserBrief is the appointment list's patient include:
// `{ select: { id, name, avatar, phone_number } }`.
func (s *Server) apptUserBrief(ctx context.Context, userID string) (map[string]any, error) {
	var name, avatar, phone *string
	err := s.DB.QueryRowContext(ctx, "SELECT name, avatar, phone_number FROM `User` WHERE id = ?", userID).Scan(&name, &avatar, &phone)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": userID, "name": name, "avatar": avatar, "phone_number": phone}, nil
}

// apptPreSessionJSON selects the same columns the appointment service selects:
// patients never see the questions, the doctor does.
func (s *Server) apptPreSessionJSON(ctx context.Context, appointmentID string, includeQuestions bool) (any, error) {
	var questions, answers, briefing *string
	err := s.DB.QueryRowContext(ctx,
		"SELECT questionsJson, answersJson, briefingText FROM `PreSessionData` WHERE appointmentId = ?", appointmentID).
		Scan(&questions, &answers, &briefing)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{"answersJson": answers, "briefingText": briefing}
	if includeQuestions {
		out["questionsJson"] = questions
	}
	return out, nil
}

const followUpColumns = "id, appointmentId, doctorId, suggestedDate, startTime, endTime, consultationType, notes, status, createdAt"

type followUpRow struct {
	ID               string
	AppointmentID    string
	DoctorID         string
	SuggestedDate    time.Time
	StartTime        string
	EndTime          string
	ConsultationType string
	Notes            *string
	Status           string
	CreatedAt        time.Time
}

func scanFollowUpRow(sc apptScanner) (*followUpRow, error) {
	var f followUpRow
	err := sc.Scan(&f.ID, &f.AppointmentID, &f.DoctorID, &f.SuggestedDate, &f.StartTime, &f.EndTime,
		&f.ConsultationType, &f.Notes, &f.Status, &f.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (f *followUpRow) JSON() map[string]any {
	return map[string]any{
		"id":               f.ID,
		"appointmentId":    f.AppointmentID,
		"doctorId":         f.DoctorID,
		"suggestedDate":    jsTimeValue(f.SuggestedDate),
		"startTime":        f.StartTime,
		"endTime":          f.EndTime,
		"consultationType": f.ConsultationType,
		"notes":            f.Notes,
		"status":           f.Status,
		"createdAt":        jsTimeValue(f.CreatedAt),
	}
}

// apptFollowUpJSON is the `followUp: true` include on an appointment: null
// when there is no suggestion.
func (s *Server) apptFollowUpJSON(ctx context.Context, appointmentID string) (any, error) {
	f, err := scanFollowUpRow(s.DB.QueryRowContext(ctx,
		"SELECT "+followUpColumns+" FROM `FollowUp` WHERE appointmentId = ?", appointmentID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return f.JSON(), nil
}

// apptDoctorFullRow is the admin list's doctor include: every Doctor scalar.
func (s *Server) apptDoctorFullRow(ctx context.Context, doctorID string) (map[string]any, error) {
	var (
		id, userID, specialty, bio, availability, verificationStatus string
		experience, totalReviews, price                              int
		rating                                                       float64
		languages, education, bankName, bankAccount, bankHolder      *string
		licenseNumber, licenseIssuer                                 *string
		awayUntil                                                    *time.Time
		createdAt, updatedAt                                         time.Time
		name                                                         *string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT id, userId, specialty, bio, experience, rating, totalReviews, languages, education, price, "+
			"bankName, bankAccount, bankHolder, availability, verificationStatus, licenseNumber, licenseIssuer, "+
			"awayUntil, createdAt, updatedAt FROM `Doctor` WHERE id = ?", doctorID).
		Scan(&id, &userID, &specialty, &bio, &experience, &rating, &totalReviews, &languages, &education,
			&price, &bankName, &bankAccount, &bankHolder, &availability, &verificationStatus,
			&licenseNumber, &licenseIssuer, &awayUntil, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := s.DB.QueryRowContext(ctx, "SELECT name FROM `User` WHERE id = ?", userID).Scan(&name); err != nil {
		return nil, err
	}
	return map[string]any{
		"id":                 id,
		"userId":             userID,
		"specialty":          specialty,
		"bio":                bio,
		"experience":         experience,
		"rating":             rating,
		"totalReviews":       totalReviews,
		"languages":          languages,
		"education":          education,
		"price":              price,
		"bankName":           bankName,
		"bankAccount":        bankAccount,
		"bankHolder":         bankHolder,
		"availability":       availability,
		"verificationStatus": verificationStatus,
		"licenseNumber":      licenseNumber,
		"licenseIssuer":      licenseIssuer,
		"awayUntil":          jsTime(awayUntil),
		"createdAt":          jsTimeValue(createdAt),
		"updatedAt":          jsTimeValue(updatedAt),
		"user":               map[string]any{"name": name},
	}, nil
}

/* ------------------------------------------------------------------ *
 * POST /appointments/book
 * ------------------------------------------------------------------ */

type apptBookBody struct {
	DoctorID          string  `json:"doctorId"`
	AppointmentDate   string  `json:"appointmentDate"`
	StartTime         string  `json:"startTime"`
	EndTime           string  `json:"endTime"`
	ConsultationType  *string `json:"consultationType"`
	SlotID            *string `json:"slotId"`
	IdempotencyKey    *string `json:"idempotencyKey"`
	Notes             *string `json:"notes"`
	PackagePurchaseID *string `json:"packagePurchaseId"`
}

func (s *Server) handleApptBook(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)

	var body apptBookBody
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if !apptUUID7OK(body.DoctorID) {
		s.validationFail(w, "body.doctorId", "Invalid id")
		return
	}
	if msg := apptISODayError(body.AppointmentDate, "Appointment date"); msg != "" {
		s.validationFail(w, "body.appointmentDate", msg)
		return
	}
	if msg := apptHHMMError(body.StartTime, "Start time"); msg != "" {
		s.validationFail(w, "body.startTime", msg)
		return
	}
	if msg := apptHHMMError(body.EndTime, "End time"); msg != "" {
		s.validationFail(w, "body.endTime", msg)
		return
	}
	if body.ConsultationType != nil {
		if msg := apptEnumError(*body.ConsultationType, "video", "voice", "chat"); msg != "" {
			s.validationFail(w, "body.consultationType", msg)
			return
		}
	}
	if body.SlotID != nil && !apptUUID7OK(*body.SlotID) {
		s.validationFail(w, "body.slotId", "Invalid id")
		return
	}
	if body.IdempotencyKey != nil {
		if len(*body.IdempotencyKey) < 8 {
			s.validationFail(w, "body.idempotencyKey", "Too small: expected string to have >=8 characters")
			return
		}
		if len(*body.IdempotencyKey) > 64 {
			s.validationFail(w, "body.idempotencyKey", "Too big: expected string to have <=64 characters")
			return
		}
	}
	if body.Notes != nil && len([]rune(*body.Notes)) > 1000 {
		s.validationFail(w, "body.notes", "Notes must be under 1000 characters")
		return
	}
	if body.PackagePurchaseID != nil && !apptUUID7OK(*body.PackagePurchaseID) {
		s.validationFail(w, "body.packagePurchaseId", "Invalid id")
		return
	}

	row, doctorUserID, err := s.apptCreate(r.Context(), user.ID, &body)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to book appointment.")
		return
	}

	// The controller notifies the doctor after responding; doing it first keeps
	// the notification observable by the client's very next request, which is
	// what the integration suite relies on.
	if doctorUserID != "" {
		s.apptNotify(r.Context(), doctorUserID, "New Appointment Request",
			fmt.Sprintf("A patient has booked a session on %s at %s.", apptFormatUS(row.AppointmentDate), body.StartTime),
			"appointment")
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": row.JSON()})
}

// apptCreate ports AppointmentService.createAppointment end to end, including
// the idempotency contract, the atomic slot claim and the reservation refund
// that guards every path after capacity is taken.
func (s *Server) apptCreate(ctx context.Context, userID string, body *apptBookBody) (*apptRow, string, error) {
	// Idempotency: the stored result may only be returned to its owner. The
	// controller still notifies the doctor on a replay, so the doctor user id
	// is resolved here too.
	if body.IdempotencyKey != nil {
		existing, err := scanApptRow(s.DB.QueryRowContext(ctx,
			"SELECT "+apptColumns+" FROM `Appointment` WHERE idempotencyKey = ?", *body.IdempotencyKey))
		if err == nil {
			if existing.UserID != userID {
				return nil, "", Conflict("This idempotency key is already in use")
			}
			var doctorUserID string
			if err := s.DB.QueryRowContext(ctx, "SELECT userId FROM `Doctor` WHERE id = ?", existing.DoctorID).Scan(&doctorUserID); err != nil && err != sql.ErrNoRows {
				return nil, "", err
			}
			return existing, doctorUserID, nil
		}
		if err != sql.ErrNoRows {
			return nil, "", err
		}
	}

	var (
		doctorUserID string
		verification string
		awayUntil    *time.Time
		doctorPrice  int
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT userId, verificationStatus, awayUntil, price FROM `Doctor` WHERE id = ?", body.DoctorID).
		Scan(&doctorUserID, &verification, &awayUntil, &doctorPrice)
	if err == sql.ErrNoRows {
		return nil, "", NotFound("Doctor not found")
	}
	if err != nil {
		return nil, "", err
	}
	if verification != "approved" {
		return nil, "", BadRequest("This doctor is not accepting bookings yet")
	}

	// Package session: ownership, active status and doctor match are checked
	// here; the session itself is claimed atomically below.
	var packageReservationID *string
	if body.PackagePurchaseID != nil {
		var purchaseUserID, purchaseStatus, packageDoctorID string
		var sessionsLeft int
		err := s.DB.QueryRowContext(ctx,
			"SELECT p.userId, p.status, p.sessionsLeft, pk.doctorId FROM `PackagePurchase` p "+
				"JOIN `Package` pk ON pk.id = p.packageId WHERE p.id = ?", *body.PackagePurchaseID).
			Scan(&purchaseUserID, &purchaseStatus, &sessionsLeft, &packageDoctorID)
		if err != nil && err != sql.ErrNoRows {
			return nil, "", err
		}
		if err == sql.ErrNoRows || purchaseUserID != userID || purchaseStatus != "active" || sessionsLeft < 1 {
			return nil, "", BadRequest("Package session is not available")
		}
		if packageDoctorID != body.DoctorID {
			return nil, "", BadRequest("This package belongs to a different doctor")
		}
		packageReservationID = body.PackagePurchaseID
	}

	date := apptParseLocalDate(body.AppointmentDate)
	if date.IsZero() {
		return nil, "", BadRequest("Invalid appointment date")
	}

	if awayUntil != nil {
		au := awayUntil.UTC()
		awayEnd := time.Date(au.Year(), au.Month(), au.Day(), 23, 59, 59, 999000000, time.UTC)
		if !date.After(awayEnd) {
			return nil, "", BadRequest("This doctor is currently away and not accepting bookings")
		}
	}

	start, startOK := apptTimeToMinutes(body.StartTime)
	end, endOK := apptTimeToMinutes(body.EndTime)
	if !startOK || !endOK || start >= end {
		return nil, "", BadRequest("Invalid appointment time")
	}

	// Block booking in the past, judged in the booker's calendar zone.
	var timezone *string
	if err := s.DB.QueryRowContext(ctx, "SELECT timezone FROM `User` WHERE id = ?", userID).Scan(&timezone); err != nil && err != sql.ErrNoRows {
		return nil, "", err
	}
	tz := apptResolveTimezone(timezone)
	dayStart := apptZonedDayStart(apptLocalDateKey(date), tz)
	slotStart := dayStart.Add(time.Duration(start) * time.Minute)
	if slotStart.Before(time.Now().Add(-60 * time.Second)) {
		return nil, "", BadRequest("Cannot book appointments in the past")
	}

	// Reserve paid-for capacity atomically before touching slots.
	var packagePurchaseID *string
	creditApplied := false
	if packageReservationID != nil {
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `PackagePurchase` SET sessionsLeft = sessionsLeft - 1 WHERE id = ? AND status = 'active' AND sessionsLeft >= 1",
			*packageReservationID)
		if err != nil {
			return nil, "", err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, "", BadRequest("Package session is not available")
		}
		// Exhausted packages flip to completed immediately.
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `PackagePurchase` SET status = 'completed' WHERE id = ? AND sessionsLeft = 0", *packageReservationID); err != nil {
			s.Log.Warn("package completion flip failed", "err", err)
		}
		packagePurchaseID = packageReservationID
	} else if doctorPrice > 0 {
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET sessionCredits = sessionCredits - 1, updatedAt = ? WHERE id = ? AND sessionCredits > 0",
			time.Now().UTC(), userID)
		if err != nil {
			return nil, "", err
		}
		creditApplied, _ = apptRowsAffectedOne(res)
	}

	// Idempotent by construction: every exit after a reservation runs refund
	// exactly once, and the single error path below owns all of them.
	refunded := false
	refundReservations := func() {
		if refunded {
			return
		}
		refunded = true
		now := time.Now().UTC()
		if packagePurchaseID != nil {
			if _, err := s.DB.ExecContext(ctx,
				"UPDATE `PackagePurchase` SET sessionsLeft = sessionsLeft + 1, status = 'active' WHERE id = ?", *packagePurchaseID); err != nil {
				s.Log.Warn("package refund failed", "err", err)
			}
		}
		if creditApplied {
			if _, err := s.DB.ExecContext(ctx,
				"UPDATE `User` SET sessionCredits = sessionCredits + 1, updatedAt = ? WHERE id = ?", now, userID); err != nil {
				s.Log.Warn("credit refund failed", "err", err)
			}
		}
	}

	var slotID *string
	releaseSlot := func() {
		if slotID != nil {
			if _, err := s.DB.ExecContext(ctx, "UPDATE `ConsultationSlot` SET isBooked = false WHERE id = ?", *slotID); err != nil {
				s.Log.Warn("slot release failed", "err", err)
			}
		}
	}

	appointmentID := newID()
	now := time.Now().UTC()
	var notes *string
	if body.Notes != nil && *body.Notes != "" {
		clean := s.apptSanitizeText(*body.Notes)
		notes = &clean
	}

	fail := func(err error) (*apptRow, string, error) {
		releaseSlot()
		refundReservations()
		return nil, "", err
	}

	if body.SlotID != nil {
		var slotIDFound string
		var slotDate time.Time
		err := s.DB.QueryRowContext(ctx,
			"SELECT id, date FROM `ConsultationSlot` WHERE id = ? AND doctorId = ?", *body.SlotID, body.DoctorID).
			Scan(&slotIDFound, &slotDate)
		if err == sql.ErrNoRows {
			return fail(NotFound("Slot not found for this doctor"))
		}
		if err != nil {
			return fail(err)
		}
		if apptLocalDateKey(slotDate) != apptLocalDateKey(date) {
			return fail(BadRequest("Slot date does not match appointment date"))
		}
		// Atomic claim: the UPDATE only matches while the slot is still free,
		// so two concurrent bookings cannot both win the race.
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `ConsultationSlot` SET isBooked = true WHERE id = ? AND isBooked = false", slotIDFound)
		if err != nil {
			return fail(err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return fail(Conflict("Slot is already booked"))
		}
		slotID = &slotIDFound
	}

	// Overlap scan against the doctor's other active bookings for the day.
	dayEnd := date.AddDate(0, 0, 1)
	rows, err := s.DB.QueryContext(ctx,
		"SELECT startTime, endTime FROM `Appointment` WHERE doctorId = ? AND appointmentDate >= ? AND appointmentDate < ? AND status IN ('pending','confirmed')",
		body.DoctorID, date, dayEnd)
	if err != nil {
		return fail(err)
	}
	hasConflict := false
	for rows.Next() {
		var bStart, bEnd *string
		if err := rows.Scan(&bStart, &bEnd); err != nil {
			rows.Close()
			return fail(err)
		}
		bS, bSOK := apptTimeToMinutes(apptStrOr(bStart, ""))
		bE, bEOK := apptTimeToMinutes(apptStrOr(bEnd, ""))
		if bSOK && bEOK && apptOverlap(start, end, bS, bE) {
			hasConflict = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fail(err)
	}
	if hasConflict {
		return fail(Conflict("This time is already booked for that doctor"))
	}

	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `Appointment` (id, userId, doctorId, slotId, appointmentDate, startTime, endTime, consultationType, "+
			"status, notes, idempotencyKey, creditApplied, packagePurchaseId, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		appointmentID, userID, body.DoctorID, slotID, date, body.StartTime, body.EndTime,
		body.resolveType(), "pending", notes, body.IdempotencyKey, creditApplied, packagePurchaseID, now, now)
	if err != nil {
		return fail(err)
	}

	// The reservation is now carried by a real appointment row.
	refunded = true

	s.apptWaitlistMarkBooked(ctx, body.DoctorID, userID)

	row, err := s.apptByID(ctx, appointmentID)
	if err != nil {
		return nil, "", err
	}
	return row, doctorUserID, nil
}

func apptRowsAffectedOne(res sql.Result) (bool, error) {
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

/* ------------------------------------------------------------------ *
 * GET /appointments/my
 * ------------------------------------------------------------------ */

func (s *Server) handleApptMy(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	page := apptPageParam(r.URL.Query().Get("page"), 1)
	limit := apptPageParam(r.URL.Query().Get("limit"), 20)

	result, err := s.apptGetMy(r.Context(), user, page, limit)
	if err != nil {
		// The controller hard-codes 500 here while still surfacing the typed
		// message.
		s.apptControllerErrFixed(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": result})
}

func (s *Server) apptGetMy(ctx context.Context, user *UserCtx, page, limit int) (map[string]any, error) {
	skip := (page - 1) * limit
	if skip < 0 {
		skip = 0
	}
	take := limit
	if take > 50 {
		take = 50
	}
	if take < 0 {
		take = 0
	}

	var (
		total    int
		role     = user.Role
		doctorID string
	)

	switch role {
	case "doctor":
		if user.DoctorProfileID == nil {
			return nil, NotFound("Doctor profile not found")
		}
		doctorID = *user.DoctorProfileID
		if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Appointment` WHERE doctorId = ?", doctorID).Scan(&total); err != nil {
			return nil, err
		}
		rows, err := s.apptQueryRows(ctx, "WHERE doctorId = ?", []any{doctorID}, skip, take)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(rows))
		for _, a := range rows {
			m := a.JSON()
			patient, err := s.apptUserBrief(ctx, a.UserID)
			if err != nil {
				return nil, err
			}
			pre, err := s.apptPreSessionJSON(ctx, a.ID, true)
			if err != nil {
				return nil, err
			}
			fu, err := s.apptFollowUpJSON(ctx, a.ID)
			if err != nil {
				return nil, err
			}
			m["user"] = patient
			m["preSessionData"] = pre
			m["followUp"] = fu
			out = append(out, m)
		}
		return apptListPayload(out, total, page, take), nil

	case "admin":
		if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Appointment`").Scan(&total); err != nil {
			return nil, err
		}
		rows, err := s.apptQueryRows(ctx, "", nil, skip, take)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(rows))
		for _, a := range rows {
			m := a.JSON()
			u, err := s.apptUserBrief(ctx, a.UserID)
			if err != nil {
				return nil, err
			}
			// Admin sees the patient's brief without the phone number.
			m["user"] = map[string]any{"id": u["id"], "name": u["name"], "avatar": u["avatar"]}
			doc, err := s.apptDoctorFullRow(ctx, a.DoctorID)
			if err != nil {
				return nil, err
			}
			m["doctor"] = doc
			out = append(out, m)
		}
		return apptListPayload(out, total, page, take), nil
	}

	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Appointment` WHERE userId = ?", user.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.apptQueryRows(ctx, "WHERE userId = ?", []any{user.ID}, skip, take)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, a := range rows {
		m := a.JSON()
		doc, err := s.apptDoctorAllowlist(ctx, a.DoctorID)
		if err != nil {
			return nil, err
		}
		pre, err := s.apptPreSessionJSON(ctx, a.ID, false)
		if err != nil {
			return nil, err
		}
		fu, err := s.apptFollowUpJSON(ctx, a.ID)
		if err != nil {
			return nil, err
		}
		m["doctor"] = doc
		m["preSessionData"] = pre
		m["followUp"] = fu
		out = append(out, m)
	}
	return apptListPayload(out, total, page, take), nil
}

func apptListPayload(out []map[string]any, total, page, take int) map[string]any {
	payload := map[string]any{
		"rows":  out,
		"total": total,
		"page":  page,
	}
	if take > 0 {
		payload["totalPages"] = int(math.Ceil(float64(total) / float64(take)))
	} else {
		// `Math.ceil(total / 0)` is Infinity, which JSON.stringify renders as
		// null.
		payload["totalPages"] = nil
	}
	return payload
}

func (s *Server) apptQueryRows(ctx context.Context, where string, args []any, skip, take int) ([]*apptRow, error) {
	query := "SELECT " + apptColumns + " FROM `Appointment` "
	if where != "" {
		query += where + " "
	}
	query += "ORDER BY appointmentDate DESC, startTime DESC LIMIT ? OFFSET ?"
	args = append(args, take, skip)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*apptRow
	for rows.Next() {
		a, err := scanApptRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

/* ------------------------------------------------------------------ *
 * GET /appointments/:id/ics
 * ------------------------------------------------------------------ */

var apptIcsNewlines = regexp.MustCompile(`\r?\n`)

func apptIcsEscape(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, ";", `\;`)
	v = strings.ReplaceAll(v, ",", `\,`)
	return apptIcsNewlines.ReplaceAllString(v, `\n`)
}

// apptIcsDate is toISOString with separators and milliseconds stripped.
func apptIcsDate(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

func (s *Server) handleApptICS(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		s.Fail(w, http.StatusBadRequest, "Invalid appointment id")
		return
	}
	user := CurrentUser(r)

	var (
		userID, doctorUserID        string
		userName, doctorUserName    *string
		appointmentDate             time.Time
		startTime, endTime, meeting *string
		consultationType, status    string
	)
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT a.userId, u.name, du.id, du.name, a.appointmentDate, a.startTime, a.endTime, a.consultationType, a.status, a.meetingLink "+
			"FROM `Appointment` a JOIN `User` u ON u.id = a.userId "+
			"JOIN `Doctor` d ON d.id = a.doctorId JOIN `User` du ON du.id = d.userId WHERE a.id = ?", id).
		Scan(&userID, &userName, &doctorUserID, &doctorUserName, &appointmentDate, &startTime, &endTime, &consultationType, &status, &meeting)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Appointment not found")
		return
	}
	if err != nil {
		s.apptControllerErrFixed(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	if status != "confirmed" {
		s.Fail(w, http.StatusBadRequest, "Only confirmed appointments can be exported")
		return
	}
	isPatient := userID == user.ID
	isDoctor := doctorUserID == user.ID
	if !isPatient && !isDoctor {
		s.Fail(w, http.StatusForbidden, "Forbidden: not a participant")
		return
	}

	sh, sm := apptHM(startTime)
	eh, em := apptHM(endTime)
	t := appointmentDate.UTC()
	start := time.Date(t.Year(), t.Month(), t.Day(), sh, sm, 0, 0, time.UTC)
	end := time.Date(t.Year(), t.Month(), t.Day(), eh, em, 0, 0, time.UTC)
	// Sessions crossing midnight produce an earlier DTEND than DTSTART.
	if !end.After(start) {
		end = end.AddDate(0, 0, 1)
	}

	participant := apptStrOr(doctorUserName, "your doctor")
	if !isPatient {
		participant = apptStrOr(userName, "your patient")
	}
	description := fmt.Sprintf("Session with %s (%s). ", participant, consultationType)
	if meeting != nil && *meeting != "" {
		description += "Join: " + *meeting
	}
	location := "Online"
	if meeting != nil && *meeting != "" {
		location = *meeting
	}

	summary := "MindEase consultation — " + consultationType + " session"
	lines := []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//MindEase//MindEase Consultations//EN",
		"CALSCALE:GREGORIAN",
		"BEGIN:VEVENT",
		"UID:appointment-" + id + "@mindease.app",
		"DTSTAMP:" + apptIcsDate(time.Now().UTC()),
		"DTSTART:" + apptIcsDate(start),
		"DTEND:" + apptIcsDate(end),
		"SUMMARY:" + apptIcsEscape(summary),
		"DESCRIPTION:" + apptIcsEscape(description),
		"LOCATION:" + apptIcsEscape(location),
		"END:VEVENT",
		"END:VCALENDAR",
	}
	ics := strings.Join(lines, "\r\n") + "\r\n"

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="mindease-session-`+id+`.ics"`)
	if _, err := w.Write([]byte(ics)); err != nil {
		s.Log.Error("ics write failed", "err", err)
	}
}

/* ------------------------------------------------------------------ *
 * POST /appointments/:id/join
 * ------------------------------------------------------------------ */

func (s *Server) handleApptJoin(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		s.Fail(w, http.StatusBadRequest, "Invalid appointment id")
		return
	}
	user := CurrentUser(r)

	data, err := s.apptJoinRoom(r.Context(), id, user)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to join room.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *Server) apptJoinRoom(ctx context.Context, id string, actor *UserCtx) (map[string]any, error) {
	var (
		patientID, doctorUserID  string
		patientName, doctorName  *string
		patientTZ                *string
		appointmentDate          time.Time
		startTime, endTime       *string
		consultationType, status string
		roomSeed                 *string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT a.userId, pu.name, pu.timezone, du.id, du.name, a.appointmentDate, a.startTime, a.endTime, "+
			"a.consultationType, a.status, a.roomSeed "+
			"FROM `Appointment` a JOIN `User` pu ON pu.id = a.userId "+
			"JOIN `Doctor` d ON d.id = a.doctorId JOIN `User` du ON du.id = d.userId WHERE a.id = ?", id).
		Scan(&patientID, &patientName, &patientTZ, &doctorUserID, &doctorName,
			&appointmentDate, &startTime, &endTime, &consultationType, &status, &roomSeed)
	if err == sql.ErrNoRows {
		return nil, NotFound("Appointment not found")
	}
	if err != nil {
		return nil, err
	}
	if status != "confirmed" {
		return nil, BadRequest("This consultation is not active")
	}
	if consultationType != "video" && consultationType != "voice" {
		return nil, BadRequest("This consultation has no live room (text chat only)")
	}
	isPatient := patientID == actor.ID
	isDoctor := doctorUserID == actor.ID
	if !isPatient && !isDoctor {
		return nil, Forbidden("not a participant of this consultation")
	}

	// The window is judged in the booker's timezone, exactly as booking judged
	// it. Invalid stored times make both comparisons false in the Node code
	// (NaN), so the room is open; that behaviour is preserved.
	var openedAt any
	if startMinutes, ok1 := apptTimeToMinutes(apptStrOr(startTime, "00:00")); ok1 {
		if endMinutes, ok2 := apptTimeToMinutes(apptStrOr(endTime, "00:00")); ok2 {
			tz := apptResolveTimezone(patientTZ)
			dayStart := apptZonedDayStart(apptLocalDateKey(appointmentDate), tz)
			start := dayStart.Add(time.Duration(startMinutes) * time.Minute)
			end := dayStart.Add(time.Duration(endMinutes) * time.Minute)
			now := time.Now()
			openEarly := 15 * time.Minute
			closeLate := 60 * time.Minute
			if now.Before(start.Add(-openEarly)) {
				minutesUntilOpen := int(math.Ceil(start.Add(-openEarly).Sub(now).Minutes()))
				return nil, BadRequest(fmt.Sprintf("The room opens in %d minutes", minutesUntilOpen))
			}
			if now.After(end.Add(closeLate)) {
				return nil, BadRequest("This consultation room has closed")
			}
			openedAt = start.Add(-openEarly).UnixMilli()
		}
	}

	counterpartID := patientID
	if isPatient {
		counterpartID = doctorUserID
	}
	displayName := "Your counterpart"
	if actor.Name != nil && *actor.Name != "" {
		displayName = *actor.Name
	}
	s.apptPublish(counterpartID, "appointment:join", map[string]any{
		"appointmentId": id, "name": displayName, "consultationType": consultationType,
	})

	seed, err := s.apptEnsureRoomSeed(ctx, id, roomSeed)
	if err != nil {
		return nil, err
	}

	// Scope the token to the end of the window, not to a constant.
	endOfWindow := time.Now().Add(60 * time.Minute)
	if endMinutes, ok := apptTimeToMinutes(apptStrOr(endTime, "00:00")); ok {
		tz := apptResolveTimezone(patientTZ)
		dayStart := apptZonedDayStart(apptLocalDateKey(appointmentDate), tz)
		endOfWindow = dayStart.Add(time.Duration(endMinutes) * time.Minute).Add(60 * time.Minute)
	}
	participantName := "Participant"
	if actor.Name != nil && *actor.Name != "" {
		participantName = *actor.Name
	}
	grant, err := s.apptBuildGrant(id, actor.ID, participantName, seed, endOfWindow.UnixMilli())
	if err != nil {
		return nil, err
	}

	state := s.apptActiveProvider()
	var meetingLink any
	if grant.provider == "jitsi" {
		meetingLink = grant.room
	}
	var degradedReason any
	if state.degraded {
		degradedReason = state.reason
	}
	var tokenOut any
	if grant.token != nil {
		tokenOut = *grant.token
	}

	return map[string]any{
		"provider":         grant.provider,
		"room":             grant.room,
		"token":            tokenOut,
		"identity":         grant.identity,
		"meetingLink":      meetingLink,
		"degraded":         state.degraded,
		"degradedReason":   degradedReason,
		"consultationType": consultationType,
		"startTime":        startTime,
		"endTime":          endTime,
		"patient":          map[string]any{"id": patientID, "name": patientName, "timezone": patientTZ},
		"doctor":           map[string]any{"id": doctorUserID, "name": doctorName},
		"openedAt":         openedAt,
	}, nil
}

// apptEnsureRoomSeed mints the seed once: the write is conditional on the
// column being empty and the persisted value is read back, so two concurrent
// joiners cannot hold different seeds.
func (s *Server) apptEnsureRoomSeed(ctx context.Context, id string, known *string) (string, error) {
	if known != nil && *known != "" {
		return *known, nil
	}
	candidate := apptHex(8)
	_, err := s.DB.ExecContext(ctx,
		"UPDATE `Appointment` SET roomSeed = ?, updatedAt = ? WHERE id = ? AND roomSeed IS NULL",
		candidate, time.Now().UTC(), id)
	if err != nil {
		return "", err
	}
	var persisted sql.NullString
	if err := s.DB.QueryRowContext(ctx, "SELECT roomSeed FROM `Appointment` WHERE id = ?", id).Scan(&persisted); err != nil {
		return "", err
	}
	if persisted.Valid && persisted.String != "" {
		return persisted.String, nil
	}
	return candidate, nil
}

/* ------------------------------------------------------------------ *
 * PUT /appointments/:id/status
 * ------------------------------------------------------------------ */

func (s *Server) handleApptUpdateStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !apptUUID7OK(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if msg := apptEnumError(body.Status, "confirmed", "cancelled", "completed"); msg != "" {
		s.validationFail(w, "body.status", msg)
		return
	}

	actor := CurrentUser(r)
	row, err := s.apptUpdateStatus(r.Context(), id, body.Status, actor)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusForbidden, "Failed to update status.")
		return
	}

	// The controller's status-change notifications. Email is skipped (no
	// mailer in this binary); the in-app channel is honoured.
	switch body.Status {
	case "confirmed":
		s.apptNotify(r.Context(), row.UserID, "Appointment Confirmed",
			fmt.Sprintf("Your appointment on %s at %s has been confirmed.", apptFormatUS(row.AppointmentDate), apptStrOr(row.StartTime, "")),
			"appointment")
	case "cancelled":
		if actor.Role == "doctor" {
			s.apptNotify(r.Context(), row.UserID, "Appointment Cancelled",
				fmt.Sprintf("Your appointment on %s was cancelled by the doctor. Find an alternative slot from your appointments page.", apptFormatUS(row.AppointmentDate)),
				"appointment")
		} else {
			var doctorUserID string
			if err := s.DB.QueryRowContext(r.Context(), "SELECT userId FROM `Doctor` WHERE id = ?", row.DoctorID).Scan(&doctorUserID); err == nil {
				s.apptNotify(r.Context(), doctorUserID, "Appointment Cancelled",
					fmt.Sprintf("A patient cancelled their appointment on %s.", apptFormatUS(row.AppointmentDate)),
					"appointment")
			}
		}
	case "completed":
		s.apptNotify(r.Context(), row.UserID, "Session Completed",
			fmt.Sprintf("Your session on %s is complete. Don't forget to leave a review!", apptFormatUS(row.AppointmentDate)),
			"appointment")
	}

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": row.JSON()})
}

func (s *Server) apptUpdateStatus(ctx context.Context, id, status string, actor *UserCtx) (*apptRow, error) {
	appointment, err := s.apptByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if !containsString([]string{"confirmed", "cancelled", "completed"}, status) {
		return nil, BadRequest("Invalid status")
	}

	// Terminal states are immutable.
	if containsString([]string{"cancelled", "completed"}, appointment.Status) {
		return nil, Conflict("Cannot change an appointment that is already " + appointment.Status)
	}

	switch actor.Role {
	case "doctor":
		var doctorID string
		err := s.DB.QueryRowContext(ctx, "SELECT id FROM `Doctor` WHERE userId = ?", actor.ID).Scan(&doctorID)
		if err == sql.ErrNoRows || (err == nil && doctorID != appointment.DoctorID) {
			return nil, Forbidden("not your appointment")
		}
		if err != nil {
			return nil, err
		}
		if appointment.Status == "pending" && status == "completed" {
			return nil, BadRequest("Cannot complete a pending appointment")
		}
	case "patient":
		if appointment.UserID != actor.ID {
			return nil, Forbidden("not your appointment")
		}
		if status != "cancelled" {
			return nil, BadRequest("Patients can only cancel appointments")
		}
		if appointment.Status == "confirmed" {
			// Grace window: a confirmed session stays cancellable by the
			// patient until 24 hours before it starts.
			h, m := apptHM(appointment.StartTime)
			t := appointment.AppointmentDate.UTC()
			start := time.Date(t.Year(), t.Month(), t.Day(), h, m, 0, 0, time.UTC)
			if time.Until(start) < 24*time.Hour {
				return nil, BadRequest("This session starts in less than 24 hours — please contact your doctor to reschedule or cancel")
			}
		} else if appointment.Status != "pending" {
			return nil, BadRequest("Only pending appointments can be cancelled by the patient")
		}
	case "admin":
		if status == "completed" {
			return nil, BadRequest("Admins cannot complete appointments")
		}
	default:
		return nil, Unauthorized("role")
	}

	// The transition is a claim: conditional on the status that was read, so
	// exactly one request moves the appointment out of a given state and only
	// that request runs the refund/cancel work below.
	res, err := s.DB.ExecContext(ctx,
		"UPDATE `Appointment` SET status = ?, updatedAt = ? WHERE id = ? AND status = ?",
		status, time.Now().UTC(), id, appointment.Status)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return nil, Conflict("This appointment was changed by someone else — reload to see its current state")
	}
	updated, err := s.apptByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// A confirmed live appointment needs a stable room identity before either
	// party joins.
	if status == "confirmed" && updated.RoomSeed == nil &&
		(updated.ConsultationType == "video" || updated.ConsultationType == "voice") {
		seed, err := s.apptEnsureRoomSeed(ctx, id, nil)
		if err != nil {
			return nil, err
		}
		updated.RoomSeed = &seed

		// Only mint the persistent URL on the degraded jitsi path.
		if s.apptActiveProvider().provider == "jitsi" && updated.MeetingLink == nil {
			link := apptJitsiRoom(id)
			if _, err := s.DB.ExecContext(ctx,
				"UPDATE `Appointment` SET meetingLink = ?, updatedAt = ? WHERE id = ?", link, time.Now().UTC(), id); err != nil {
				return nil, err
			}
			updated.MeetingLink = &link
		}
	}

	actorID := actor.ID
	s.audit(ctx, "appointment."+status, &actorID, ptr("Appointment"), &id, map[string]any{
		"from": appointment.Status, "to": status, "role": actor.Role,
	})

	if status == "cancelled" && updated.SlotID != nil {
		// Clearing the link matters as much as the flag: slotId is unique, so
		// leaving it attached would make the freed slot permanently
		// unbookable.
		if _, err := s.DB.ExecContext(ctx, "UPDATE `ConsultationSlot` SET isBooked = false WHERE id = ?", *updated.SlotID); err != nil {
			s.Log.Warn("slot release failed", "err", err)
		}
		if _, err := s.DB.ExecContext(ctx, "UPDATE `Appointment` SET slotId = NULL, updatedAt = ? WHERE id = ?", time.Now().UTC(), id); err != nil {
			s.Log.Warn("slot link clear failed", "err", err)
		}
		updated.SlotID = nil
		s.apptWaitlistNotify(ctx, updated.DoctorID)
	}

	// Refund the credit or package session used for a cancelled booking.
	if status == "cancelled" && (updated.CreditApplied || updated.PackagePurchaseID != nil) {
		now := time.Now().UTC()
		if updated.CreditApplied {
			if _, err := s.DB.ExecContext(ctx,
				"UPDATE `User` SET sessionCredits = sessionCredits + 1, updatedAt = ? WHERE id = ?", now, updated.UserID); err != nil {
				s.Log.Warn("credit refund failed", "err", err)
			}
		}
		if updated.PackagePurchaseID != nil {
			if _, err := s.DB.ExecContext(ctx,
				"UPDATE `PackagePurchase` SET sessionsLeft = sessionsLeft + 1, status = 'active' WHERE id = ?", *updated.PackagePurchaseID); err != nil {
				s.Log.Warn("package refund failed", "err", err)
			}
		}
	}

	// Referral reward: the referrer earns a credit when their referred patient
	// completes a first session. The claim-then-count ordering means at most
	// one completion ever reaches the credit.
	if status == "completed" {
		var referralID, referrerID string
		err := s.DB.QueryRowContext(ctx,
			"SELECT id, referrerId FROM `Referral` WHERE referredId = ? AND status = 'pending' LIMIT 1", updated.UserID).
			Scan(&referralID, &referrerID)
		if err == nil {
			var completedCount int
			if err := s.DB.QueryRowContext(ctx,
				"SELECT COUNT(*) FROM `Appointment` WHERE userId = ? AND status = 'completed'", updated.UserID).
				Scan(&completedCount); err != nil {
				return nil, err
			}
			if completedCount == 1 {
				tx, err := s.DB.BeginTx(ctx, nil)
				if err != nil {
					return nil, err
				}
				defer tx.Rollback()
				if _, err := tx.ExecContext(ctx, "UPDATE `Referral` SET status = 'credited' WHERE id = ?", referralID); err != nil {
					return nil, err
				}
				if _, err := tx.ExecContext(ctx,
					"UPDATE `User` SET sessionCredits = sessionCredits + 1, updatedAt = ? WHERE id = ?", time.Now().UTC(), referrerID); err != nil {
					return nil, err
				}
				if err := tx.Commit(); err != nil {
					return nil, err
				}
				s.apptNotify(ctx, referrerID, "Referral complete — you earned a free session 🎉",
					"Thanks to your referral, a friend completed their first session. A session credit has been added to your account and will automatically cover your next booking.",
					"system")
			}
		} else if err != sql.ErrNoRows {
			return nil, err
		}
	}

	return updated, nil
}

/* ------------------------------------------------------------------ *
 * PUT /appointments/:id/reschedule
 * ------------------------------------------------------------------ */

type apptRescheduleBody struct {
	AppointmentDate string  `json:"appointmentDate"`
	StartTime       string  `json:"startTime"`
	EndTime         string  `json:"endTime"`
	SlotID          *string `json:"slotId"`
}

func (s *Server) handleApptReschedule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !apptUUID7OK(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return
	}
	var body apptRescheduleBody
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if msg := apptISODayError(body.AppointmentDate, "Appointment date"); msg != "" {
		s.validationFail(w, "body.appointmentDate", msg)
		return
	}
	if msg := apptHHMMError(body.StartTime, "Start time"); msg != "" {
		s.validationFail(w, "body.startTime", msg)
		return
	}
	if msg := apptHHMMError(body.EndTime, "End time"); msg != "" {
		s.validationFail(w, "body.endTime", msg)
		return
	}
	if body.SlotID != nil && !apptUUID7OK(*body.SlotID) {
		s.validationFail(w, "body.slotId", "Invalid id")
		return
	}

	row, err := s.apptReschedule(r.Context(), id, CurrentUser(r), &body)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to reschedule appointment.")
		return
	}

	// Notify the doctor about the reschedule.
	var doctorUserID string
	if err := s.DB.QueryRowContext(r.Context(), "SELECT userId FROM `Doctor` WHERE id = ?", row.DoctorID).Scan(&doctorUserID); err == nil {
		s.apptNotify(r.Context(), doctorUserID, "Appointment Rescheduled",
			fmt.Sprintf("A patient rescheduled their appointment to %s at %s. Please re-confirm.", apptFormatUS(row.AppointmentDate), apptStrOr(row.StartTime, "")),
			"appointment")
	}

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": row.JSON()})
}

func (s *Server) apptReschedule(ctx context.Context, id string, actor *UserCtx, body *apptRescheduleBody) (*apptRow, error) {
	appointment, err := s.apptByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if appointment.UserID != actor.ID {
		return nil, Forbidden("not your appointment")
	}
	if appointment.Status != "confirmed" && appointment.Status != "pending" {
		return nil, BadRequest("Only pending or confirmed appointments can be rescheduled")
	}

	date := apptParseLocalDate(body.AppointmentDate)
	if date.IsZero() {
		return nil, BadRequest("Invalid date")
	}
	start, startOK := apptTimeToMinutes(body.StartTime)
	end, endOK := apptTimeToMinutes(body.EndTime)
	if !startOK || !endOK || start >= end {
		return nil, BadRequest("Invalid time")
	}

	// Block rescheduling into the past.
	t := date.UTC()
	newStart := time.Date(t.Year(), t.Month(), t.Day(), start/60, start%60, 0, 0, time.UTC)
	if newStart.Before(time.Now()) {
		return nil, BadRequest("Cannot reschedule into the past")
	}

	// `slotID` is the slot the appointment ends up pointing at; `claimedSlotID`
	// is only what this request actually claimed. Compensation must release
	// only the latter.
	var slotID *string
	var claimedSlotID *string
	if body.SlotID != nil {
		var foundID string
		var slotDate time.Time
		err := s.DB.QueryRowContext(ctx,
			"SELECT id, date FROM `ConsultationSlot` WHERE id = ? AND doctorId = ?", *body.SlotID, appointment.DoctorID).
			Scan(&foundID, &slotDate)
		if err == sql.ErrNoRows {
			return nil, NotFound("Slot not found for this doctor")
		}
		if err != nil {
			return nil, err
		}
		if apptLocalDateKey(slotDate) != apptLocalDateKey(date) {
			return nil, BadRequest("Slot date does not match appointment date")
		}
		if appointment.SlotID == nil || foundID != *appointment.SlotID {
			res, err := s.DB.ExecContext(ctx,
				"UPDATE `ConsultationSlot` SET isBooked = true WHERE id = ? AND isBooked = false", foundID)
			if err != nil {
				return nil, err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return nil, Conflict("Slot is already booked")
			}
			claimedSlotID = &foundID
		}
		slotID = &foundID
	}

	releaseClaimed := func() {
		if claimedSlotID != nil {
			if _, err := s.DB.ExecContext(ctx, "UPDATE `ConsultationSlot` SET isBooked = false WHERE id = ?", *claimedSlotID); err != nil {
				s.Log.Warn("claimed slot release failed", "err", err)
			}
		}
	}

	// Conflict scan against the doctor's other active bookings.
	dayEnd := date.AddDate(0, 0, 1)
	rows, err := s.DB.QueryContext(ctx,
		"SELECT startTime, endTime FROM `Appointment` WHERE doctorId = ? AND id <> ? AND appointmentDate >= ? AND appointmentDate < ? AND status IN ('pending','confirmed')",
		appointment.DoctorID, id, date, dayEnd)
	if err != nil {
		releaseClaimed()
		return nil, err
	}
	hasConflict := false
	for rows.Next() {
		var bStart, bEnd *string
		if err := rows.Scan(&bStart, &bEnd); err != nil {
			rows.Close()
			releaseClaimed()
			return nil, err
		}
		bS, bSOK := apptTimeToMinutes(apptStrOr(bStart, ""))
		bE, bEOK := apptTimeToMinutes(apptStrOr(bEnd, ""))
		if bSOK && bEOK && apptOverlap(start, end, bS, bE) {
			hasConflict = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		releaseClaimed()
		return nil, err
	}
	if hasConflict {
		releaseClaimed()
		return nil, Conflict("This time is already booked for that doctor")
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		releaseClaimed()
		return nil, err
	}
	defer tx.Rollback()

	// The pre-session disclosure and its briefing describe the previous
	// appointment, so they are removed rather than carried into the new time.
	if _, err := tx.ExecContext(ctx, "DELETE FROM `PreSessionData` WHERE appointmentId = ?", id); err != nil {
		releaseClaimed()
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE `Appointment` SET appointmentDate = ?, startTime = ?, endTime = ?, slotId = ?, status = 'pending', "+
			"meetingLink = NULL, roomSeed = NULL, reminderSentAt = NULL, checkinSentAt = NULL, updatedAt = ? WHERE id = ?",
		date, body.StartTime, body.EndTime, slotID, time.Now().UTC(), id); err != nil {
		releaseClaimed()
		return nil, err
	}
	updated, err := scanApptRow(tx.QueryRowContext(ctx, "SELECT "+apptColumns+" FROM `Appointment` WHERE id = ?", id))
	if err != nil {
		releaseClaimed()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		releaseClaimed()
		return nil, err
	}

	// Release the previous slot only after the move succeeded, and only when
	// it actually changed.
	if appointment.SlotID != nil && (slotID == nil || *appointment.SlotID != *slotID) {
		if _, err := s.DB.ExecContext(ctx, "UPDATE `ConsultationSlot` SET isBooked = false WHERE id = ?", *appointment.SlotID); err != nil {
			s.Log.Warn("old slot release failed", "err", err)
		}
	}

	return updated, nil
}

/* ------------------------------------------------------------------ *
 * GET /appointments/:id/rebook-options
 * ------------------------------------------------------------------ */

func (s *Server) handleApptRebookOptions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		s.Fail(w, http.StatusBadRequest, "Invalid appointment id")
		return
	}
	data, err := s.apptRebookOptions(r.Context(), id, CurrentUser(r))
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to fetch rebook options.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *Server) apptRebookOptions(ctx context.Context, id string, actor *UserCtx) (map[string]any, error) {
	var (
		userID, doctorID, specialty, doctorUserID string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT a.userId, d.id, d.specialty, d.userId FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId WHERE a.id = ?", id).
		Scan(&userID, &doctorID, &specialty, &doctorUserID)
	if err == sql.ErrNoRows {
		return nil, NotFound("Appointment not found")
	}
	if err != nil {
		return nil, err
	}
	isPatient := userID == actor.ID
	isDoctor := actor.Role == "doctor" && doctorUserID == actor.ID
	if !isPatient && !isDoctor {
		return nil, Forbidden("not a participant")
	}

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	horizon := today.AddDate(0, 0, 14)

	sameDoctorSlots, err := s.apptSlots(ctx, doctorID, today, horizon, 3)
	if err != nil {
		return nil, err
	}

	// Same-specialty doctors, excluding this one.
	docRows, err := s.DB.QueryContext(ctx,
		"SELECT d.id, d.specialty, d.price, d.rating, u.id, u.name, u.avatar FROM `Doctor` d "+
			"JOIN `User` u ON u.id = d.userId WHERE d.specialty = ? AND d.id <> ? AND d.verificationStatus = 'approved' LIMIT 3",
		specialty, doctorID)
	if err != nil {
		return nil, err
	}
	doctorIDs := []string{}
	for docRows.Next() {
		var dID, dSpecialty, uID string
		var dPrice int
		var dRating float64
		var name, avatar *string
		if err := docRows.Scan(&dID, &dSpecialty, &dPrice, &dRating, &uID, &name, &avatar); err != nil {
			docRows.Close()
			return nil, err
		}
		doctorIDs = append(doctorIDs, dID)
	}
	docRows.Close()
	if err := docRows.Err(); err != nil {
		return nil, err
	}

	similar := []map[string]any{}
	if len(doctorIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(doctorIDs)), ",")
		args := make([]any, 0, len(doctorIDs)+2)
		for _, dID := range doctorIDs {
			args = append(args, dID)
		}
		args = append(args, today, horizon)
		rows, err := s.DB.QueryContext(ctx,
			"SELECT s.id, s.date, s.startTime, s.endTime, d.id, d.specialty, d.price, d.rating, u.id, u.name, u.avatar "+
				"FROM `ConsultationSlot` s JOIN `Doctor` d ON d.id = s.doctorId JOIN `User` u ON u.id = d.userId "+
				"WHERE s.doctorId IN ("+placeholders+") AND s.isBooked = false AND s.date >= ? AND s.date <= ? "+
				"ORDER BY s.date ASC, s.startTime ASC LIMIT 3", args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var (
				slotID, startTime, endTime, dID, dSpecialty, uID string
				slotDate                                         time.Time
				dPrice                                           int
				dRating                                          float64
				name, avatar                                     *string
			)
			if err := rows.Scan(&slotID, &slotDate, &startTime, &endTime, &dID, &dSpecialty, &dPrice, &dRating, &uID, &name, &avatar); err != nil {
				rows.Close()
				return nil, err
			}
			displayName := "Doctor"
			if name != nil && *name != "" {
				displayName = *name
			}
			similar = append(similar, map[string]any{
				"slot": map[string]any{
					"id": slotID, "date": jsTimeValue(slotDate), "startTime": startTime, "endTime": endTime,
				},
				"doctor": map[string]any{
					"id": dID, "userId": uID, "name": displayName, "avatar": avatar,
					"specialty": dSpecialty, "price": dPrice, "rating": dRating,
				},
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	return map[string]any{
		"sameDoctor": map[string]any{
			"doctorId": doctorID,
			"slots":    sameDoctorSlots,
		},
		"similarDoctors": similar,
	}, nil
}

func (s *Server) apptSlots(ctx context.Context, doctorID string, from, to time.Time, limit int) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, doctorId, date, startTime, endTime, isBooked FROM `ConsultationSlot` "+
			"WHERE doctorId = ? AND isBooked = false AND date >= ? AND date <= ? ORDER BY date ASC, startTime ASC LIMIT ?",
		doctorID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, dID, startTime, endTime string
		var date time.Time
		var isBooked bool
		if err := rows.Scan(&id, &dID, &date, &startTime, &endTime, &isBooked); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"id": id, "doctorId": dID, "date": jsTimeValue(date),
			"startTime": startTime, "endTime": endTime, "isBooked": isBooked,
		})
	}
	return out, rows.Err()
}
