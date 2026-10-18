package server

// Port of server/src/routes/wellness.routes.ts and the services it uses:
// wellness.service.ts, clinicalSafety.service.ts, riskQueue.service.ts,
// crisisText.service.ts, plus the fallback paths of ai.service.ts.
//
// The AI surface here is deliberately local-only: this service does not call
// Gemini. Every AI-backed reply is the Node fallback branch with the same
// provenance flags (`source: "fallback"` plus a `degradedReason`).

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "time/tzdata"

	"github.com/go-chi/chi/v5"
)

func (s *Server) registerWellness(api chi.Router) {
	aiRate := s.limiter(rateLimitConfig{
		name:    "ai",
		window:  10 * time.Minute,
		max:     15,
		message: "Too many AI requests, please try again later",
	})

	api.With(s.authenticate).Post("/wellness/mood", s.handleWellnessLogMood)
	api.With(s.authenticate).Get("/wellness/mood", s.handleWellnessGetMoodHistory)
	api.With(s.authenticate).Get("/wellness/mood/stats", s.handleWellnessGetMoodStats)

	api.With(s.authenticate).Post("/wellness/journal", s.handleWellnessCreateJournalEntry)
	api.With(s.authenticate).Get("/wellness/journal", s.handleWellnessGetJournalEntries)
	api.With(s.authenticate).Put("/wellness/journal/{id}", s.handleWellnessUpdateJournalEntry)
	api.With(s.authenticate).Delete("/wellness/journal/{id}", s.handleWellnessDeleteJournalEntry)
	api.With(s.authenticate, aiRate).Post("/wellness/journal/summarize", s.handleWellnessSummarizeJournal)

	api.With(s.authenticate).Post("/wellness/assessments", s.handleWellnessSubmitAssessment)
	api.With(s.authenticate).Get("/wellness/assessments", s.handleWellnessGetAssessments)
	api.With(s.authenticate).Get("/wellness/assessments/trajectory", s.handleWellnessAssessmentTrajectory)

	api.With(s.authenticate, s.RequireRole("doctor", "admin")).Get("/wellness/risk-alerts", s.handleWellnessListRiskAlerts)
	api.With(s.authenticate, s.RequireRole("doctor")).Post("/wellness/risk-alerts/{id}/acknowledge", s.handleWellnessAcknowledgeRiskAlert)
	api.With(s.authenticate, s.RequireRole("doctor")).Post("/wellness/risk-alerts/{id}/resolve", s.handleWellnessResolveRiskAlert)
}

/* ------------------------------------------------------------------ *
 * Validation, mirroring the Zod schemas and their message text
 * ------------------------------------------------------------------ */

var wellnessUUID7Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// wellnessObjectBody reads the body as a JSON object, preserving key order for
// the `Unrecognized key` message. A missing body is `{}`, like the Node
// validate middleware's `req.body ?? {}`; a JSON `null` behaves the same.
func wellnessObjectBody(r *http.Request) (map[string]any, []string, string) {
	body := map[string]any{}
	var keys []string
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	tok, err := dec.Token()
	if errors.Is(err, io.EOF) {
		return body, keys, ""
	}
	if err != nil {
		return nil, nil, "Validation Error"
	}
	if tok == nil {
		return body, keys, ""
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, nil, "Invalid input: expected object, received " + wellnessJSONType(tok)
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, nil, "Validation Error"
		}
		key, _ := kt.(string)
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, nil, "Validation Error"
		}
		if _, seen := body[key]; !seen {
			keys = append(keys, key)
		}
		body[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, "Validation Error"
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, nil, "Validation Error"
	}
	return body, keys, ""
}

func wellnessJSONType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case json.Number, float64, int, int64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "object"
	}
}

// wellnessUnknownKeys mirrors Zod's `.strict()` rejection message.
func wellnessUnknownKeys(keys []string, allowed ...string) string {
	var unknown []string
	for _, k := range keys {
		if !containsString(allowed, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) == 0 {
		return ""
	}
	quoted := make([]string, len(unknown))
	for i, k := range unknown {
		quoted[i] = `"` + k + `"`
	}
	if len(unknown) == 1 {
		return "Unrecognized key: " + quoted[0]
	}
	return "Unrecognized keys: " + strings.Join(quoted, ", ")
}

// wellnessCoercedNumber mirrors JS `Number(value)`: NaN when unreadable.
func wellnessCoercedNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case json.Number:
		return wellnessParseJSNumber(t.String())
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return wellnessParseJSNumber(t)
	case []any:
		switch len(t) {
		case 0:
			return 0
		case 1:
			return wellnessCoercedNumber(t[0])
		default:
			return math.NaN()
		}
	default:
		return math.NaN()
	}
}

// wellnessParseJSNumber follows JS `Number(string)` where it matters for
// coercion: whitespace-only is 0, Infinity/NaN round-trip, and anything else
// unparseable is NaN.
func wellnessParseJSNumber(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	case "NaN":
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if errors.Is(err, strconv.ErrRange) {
			return f
		}
		return math.NaN()
	}
	return f
}

// wellnessIntValue mirrors `z.coerce.number().int()` with the schema's custom
// min/max messages.
func wellnessIntValue(v any, exists bool, min, max int, minMsg, maxMsg string) (int, string) {
	if !exists {
		return 0, "Invalid input: expected number, received NaN"
	}
	f := wellnessCoercedNumber(v)
	if math.IsNaN(f) {
		return 0, "Invalid input: expected number, received NaN"
	}
	if math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, "Invalid input: expected int, received number"
	}
	if f < float64(min) {
		return 0, minMsg
	}
	if f > float64(max) {
		return 0, maxMsg
	}
	return int(f), ""
}

func wellnessIntBodyField(body map[string]any, name string, min, max int, minMsg, maxMsg string) (int, string) {
	v, exists := body[name]
	return wellnessIntValue(v, exists, min, max, minMsg, maxMsg)
}

func wellnessOptionalStringField(body map[string]any, name string, maxLen int, maxMsg string) (*string, string) {
	v, exists := body[name]
	if !exists {
		return nil, ""
	}
	if v == nil {
		return nil, "Invalid input: expected string, received null"
	}
	s, ok := v.(string)
	if !ok {
		return nil, "Invalid input: expected string, received " + wellnessJSONType(v)
	}
	if wellnessJSLen(s) > maxLen {
		return nil, maxMsg
	}
	return &s, ""
}

var wellnessMoodFactors = []string{"sleep", "exercise", "social", "work", "stress"}

func wellnessOptionalFactorsField(body map[string]any) ([]string, string, string) {
	v, exists := body["factors"]
	if !exists {
		return nil, "", ""
	}
	if v == nil {
		return nil, "Invalid input: expected array, received null", "body.factors"
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, "Invalid input: expected array, received " + wellnessJSONType(v), "body.factors"
	}
	out := make([]string, 0, len(arr))
	for i, el := range arr {
		s, ok := el.(string)
		if !ok || !containsString(wellnessMoodFactors, s) {
			return nil, `Invalid option: expected one of "sleep"|"exercise"|"social"|"work"|"stress"`,
				fmt.Sprintf("body.factors.%d", i)
		}
		out = append(out, s)
	}
	if len(arr) > 5 {
		return nil, "Too many factors", "body.factors"
	}
	return out, "", ""
}

func wellnessEnumField(body map[string]any, name string, allowed []string, message string) (string, string) {
	v, exists := body[name]
	if !exists || v == nil {
		return "", message
	}
	s, ok := v.(string)
	if !ok || !containsString(allowed, s) {
		return "", message
	}
	return s, ""
}

var wellnessAssessmentTypes = []string{"phq9", "gad7"}

func wellnessAnswersField(body map[string]any) ([]int, string, string) {
	v, exists := body["answers"]
	if !exists || v == nil {
		return nil, "Answers must be integers 0-3", "body.answers"
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, "Answers must be integers 0-3", "body.answers"
	}
	if len(arr) < 1 || len(arr) > 9 {
		return nil, "Answers must be integers 0-3", "body.answers"
	}
	out := make([]int, 0, len(arr))
	for i, el := range arr {
		path := fmt.Sprintf("body.answers.%d", i)
		switch el.(type) {
		case json.Number, float64, int, int64:
		default:
			return nil, "Invalid input: expected number, received " + wellnessJSONType(el), path
		}
		f := wellnessCoercedNumber(el)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, "Invalid input: expected number, received NaN", path
		}
		if math.Trunc(f) != f {
			return nil, "Invalid input: expected int, received number", path
		}
		if f < 0 {
			return nil, "Too small: expected number to be >=0", path
		}
		if f > 3 {
			return nil, "Too big: expected number to be <=3", path
		}
		out = append(out, int(f))
	}
	return out, "", ""
}

// wellnessQueryRaw distinguishes an absent query parameter from an empty one,
// and flags Express's array form for duplicated parameters.
func wellnessQueryRaw(q url.Values, name string) (string, bool, bool) {
	values, ok := q[name]
	if !ok || len(values) == 0 {
		return "", false, false
	}
	if len(values) > 1 {
		return values[0], true, true
	}
	return values[0], true, false
}

func wellnessQueryInt(value string, min, max int, minMsg, maxMsg string) (int, string) {
	return wellnessIntValue(value, true, min, max, minMsg, maxMsg)
}

func (s *Server) wellnessIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := strings.ToLower(chi.URLParam(r, "id"))
	if !wellnessUUID7Pattern.MatchString(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return "", false
	}
	return id, true
}

/* ------------------------------------------------------------------ *
 * JavaScript-compatible string lengths
 * ------------------------------------------------------------------ */

func wellnessJSLen(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func wellnessSliceJS(s string, max int) string {
	if max <= 0 {
		return ""
	}
	n := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if n+w > max {
			return s[:i]
		}
		n += w
	}
	return s
}

// wellnessSanitize mirrors utils/sanitize.ts: trim, strip markup, cap at 4000.
func (s *Server) wellnessSanitize(v string) string {
	return wellnessSliceJS(strings.TrimSpace(s.Sanitizer.Sanitize(v)), 4000)
}

/* ------------------------------------------------------------------ *
 * Timezone-aware day helpers (lib/date.ts)
 * ------------------------------------------------------------------ */

var wellnessTZCache sync.Map

func wellnessLocation(tz string) *time.Location {
	if cached, ok := wellnessTZCache.Load(tz); ok {
		return cached.(*time.Location)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.FixedZone("WIB", 7*60*60)
	}
	wellnessTZCache.Store(tz, loc)
	return loc
}

func wellnessResolveTimezone(tz *string) string {
	if tz == nil || *tz == "" {
		return "Asia/Jakarta"
	}
	if _, err := time.LoadLocation(*tz); err != nil {
		return "Asia/Jakarta"
	}
	return *tz
}

func wellnessZoneOffset(at time.Time, tz string) time.Duration {
	wall := at.In(wellnessLocation(tz))
	asUTC := time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), 0, time.UTC)
	return asUTC.Sub(at.UTC())
}

func wellnessStartOfZonedDay(key, tz string) time.Time {
	base, err := time.ParseInLocation("2006-01-02", key, time.UTC)
	if err != nil {
		return time.Now().UTC()
	}
	guess := base
	for i := 0; i < 2; i++ {
		guess = base.Add(-wellnessZoneOffset(guess, tz))
	}
	return guess
}

func wellnessDayKey(at time.Time, tz string) string {
	return at.In(wellnessLocation(tz)).Format("2006-01-02")
}

func wellnessShiftDayKey(key string, count int, tz string) string {
	base := wellnessStartOfZonedDay(key, tz)
	shifted := base.Add(time.Duration(count)*24*time.Hour + wellnessZoneOffset(base, tz))
	return wellnessDayKey(shifted, tz)
}

func wellnessTodayKey(tz string) string {
	return wellnessDayKey(time.Now().UTC(), tz)
}

func (s *Server) wellnessUserTimezone(ctx context.Context, userID string) string {
	var tz *string
	if err := s.DB.QueryRowContext(ctx, "SELECT timezone FROM `User` WHERE id = ?", userID).Scan(&tz); err != nil {
		return "Asia/Jakarta"
	}
	return wellnessResolveTimezone(tz)
}

/* ------------------------------------------------------------------ *
 * Mood tracking
 * ------------------------------------------------------------------ */

type wellnessMoodEntry struct {
	ID        string
	UserID    string
	Mood      int
	Notes     *string
	MoodDate  string
	Factors   *string
	CreatedAt time.Time
}

func (e wellnessMoodEntry) json() map[string]any {
	return map[string]any{
		"id":        e.ID,
		"userId":    e.UserID,
		"mood":      e.Mood,
		"notes":     e.Notes,
		"moodDate":  e.MoodDate,
		"factors":   e.Factors,
		"createdAt": jsTimeValue(e.CreatedAt),
	}
}

func wellnessScanMoodEntry(scan func(dest ...any) error) (wellnessMoodEntry, error) {
	var e wellnessMoodEntry
	var notes, factors sql.NullString
	if err := scan(&e.ID, &e.UserID, &e.Mood, &notes, &e.MoodDate, &factors, &e.CreatedAt); err != nil {
		return e, err
	}
	if notes.Valid {
		e.Notes = &notes.String
	}
	if factors.Valid {
		e.Factors = &factors.String
	}
	return e, nil
}

func wellnessParseFactors(raw *string) []string {
	out := []string{}
	if raw == nil {
		return out
	}
	var parsed []any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return out
	}
	for _, v := range parsed {
		if s, ok := v.(string); ok && containsString(wellnessMoodFactors, s) {
			out = append(out, s)
		}
	}
	return out
}

func (s *Server) handleWellnessLogMood(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	mood, msg := wellnessIntBodyField(body, "mood", 1, 5, "Too small: expected number to be >=1", "Mood must be between 1 and 5")
	if msg != "" {
		s.validationFail(w, "body.mood", msg)
		return
	}
	notes, msg := wellnessOptionalStringField(body, "notes", 1000, "Notes must be under 1000 characters")
	if msg != "" {
		s.validationFail(w, "body.notes", msg)
		return
	}
	factors, msg, path := wellnessOptionalFactorsField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}
	if msg := wellnessUnknownKeys(keys, "mood", "notes", "factors"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}

	var notesValue *string
	if notes != nil && *notes != "" {
		sanitized := s.wellnessSanitize(*notes)
		notesValue = &sanitized
	}
	var factorsJSON *string
	if len(factors) > 0 {
		raw, _ := json.Marshal(factors)
		value := string(raw)
		factorsJSON = &value
	}

	ctx := r.Context()
	tz := s.wellnessUserTimezone(ctx, user.ID)
	moodDate := wellnessTodayKey(tz)

	var existingID string
	replaced := false
	if err := s.DB.QueryRowContext(ctx,
		"SELECT id FROM `MoodEntry` WHERE userId = ? AND moodDate = ? LIMIT 1", user.ID, moodDate).Scan(&existingID); err == nil {
		replaced = true
	} else if err != sql.ErrNoRows {
		s.Log.Error("mood pre-read failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to log mood.")
		return
	}

	now := time.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `MoodEntry` (`id`,`userId`,`mood`,`notes`,`moodDate`,`factors`,`createdAt`) VALUES (?,?,?,?,?,?,?) AS `vals` "+
			"ON DUPLICATE KEY UPDATE `mood`=`vals`.`mood`, `notes`=`vals`.`notes`, `factors`=`vals`.`factors`",
		newID(), user.ID, mood, notesValue, moodDate, factorsJSON, now)
	if err != nil {
		s.Log.Error("mood upsert failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to log mood.")
		return
	}

	entry, err := wellnessScanMoodEntry(func(dest ...any) error {
		return s.DB.QueryRowContext(ctx,
			"SELECT id, userId, mood, notes, moodDate, factors, createdAt FROM `MoodEntry` WHERE userId = ? AND moodDate = ?",
			user.ID, moodDate).Scan(dest...)
	})
	if err != nil {
		s.Log.Error("mood read-back failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to log mood.")
		return
	}
	data := entry.json()
	data["replaced"] = replaced
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": data})
}

func (s *Server) handleWellnessGetMoodHistory(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	days := 14
	if raw, present, multi := wellnessQueryRaw(r.URL.Query(), "days"); present {
		if multi {
			s.validationFail(w, "query.days", "Invalid input: expected number, received NaN")
			return
		}
		value, msg := wellnessQueryInt(raw, 1, 365, "days must be at least 1", "days must be 365 or fewer")
		if msg != "" {
			s.validationFail(w, "query.days", msg)
			return
		}
		days = value
	}

	ctx := r.Context()
	tz := s.wellnessUserTimezone(ctx, user.ID)
	since := wellnessStartOfZonedDay(wellnessShiftDayKey(wellnessTodayKey(tz), -days, tz), tz)

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, userId, mood, notes, moodDate, factors, createdAt FROM `MoodEntry` "+
			"WHERE userId = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT ?",
		user.ID, since, days*2)
	if err != nil {
		s.Log.Error("mood history query failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to get mood history.")
		return
	}
	defer rows.Close()

	entries := make([]map[string]any, 0)
	for rows.Next() {
		entry, err := wellnessScanMoodEntry(rows.Scan)
		if err != nil {
			s.Log.Error("mood history scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to get mood history.")
			return
		}
		item := entry.json()
		item["factors"] = wellnessParseFactors(entry.Factors)
		entries = append(entries, item)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("mood history rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to get mood history.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": entries})
}

func (s *Server) handleWellnessGetMoodStats(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	windowDays := 30
	if raw, present, multi := wellnessQueryRaw(r.URL.Query(), "days"); present {
		if multi {
			s.validationFail(w, "query.days", "Invalid input: expected number, received NaN")
			return
		}
		value, msg := wellnessQueryInt(raw, 1, 365, "Too small: expected number to be >=1", "Too big: expected number to be <=365")
		if msg != "" {
			s.validationFail(w, "query.days", msg)
			return
		}
		windowDays = value
	}

	ctx := r.Context()
	tz := s.wellnessUserTimezone(ctx, user.ID)
	today := wellnessTodayKey(tz)
	from := wellnessStartOfZonedDay(wellnessShiftDayKey(today, -(windowDays-1), tz), tz)

	type moodPoint struct {
		mood      int
		factors   *string
		createdAt time.Time
	}
	rows, err := s.DB.QueryContext(ctx,
		"SELECT mood, factors, createdAt FROM `MoodEntry` WHERE userId = ? AND createdAt >= ? ORDER BY createdAt ASC",
		user.ID, from)
	if err != nil {
		s.Log.Error("mood stats query failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to get mood stats.")
		return
	}
	defer rows.Close()

	entries := make([]moodPoint, 0)
	for rows.Next() {
		var p moodPoint
		var factors sql.NullString
		if err := rows.Scan(&p.mood, &factors, &p.createdAt); err != nil {
			s.Log.Error("mood stats scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to get mood stats.")
			return
		}
		if factors.Valid {
			p.factors = &factors.String
		}
		entries = append(entries, p)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("mood stats rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to get mood stats.")
		return
	}

	if len(entries) == 0 {
		s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
			"average":           0,
			"total":             0,
			"streak":            0,
			"trend":             "stable",
			"factorCorrelation": map[string]float64{},
			"windowDays":        windowDays,
		}})
		return
	}

	sum := 0
	for _, e := range entries {
		sum += e.mood
	}
	average := float64(sum) / float64(len(entries))

	loggedDays := map[string]bool{}
	for _, e := range entries {
		loggedDays[wellnessDayKey(e.createdAt, tz)] = true
	}
	yesterday := wellnessShiftDayKey(today, -1, tz)
	streak := 0
	cursor := yesterday
	if loggedDays[today] {
		cursor = today
	}
	if loggedDays[cursor] {
		for loggedDays[cursor] && streak < 400 {
			streak++
			cursor = wellnessShiftDayKey(cursor, -1, tz)
		}
	}

	const trendThreshold = 0.3
	trend := "stable"
	if len(entries) >= 4 {
		mid := len(entries) / 2
		olderAvg := 0.0
		for _, e := range entries[:mid] {
			olderAvg += float64(e.mood)
		}
		olderAvg /= float64(len(entries[:mid]))
		recentAvg := 0.0
		for _, e := range entries[mid:] {
			recentAvg += float64(e.mood)
		}
		recentAvg /= float64(len(entries[mid:]))
		if recentAvg > olderAvg+trendThreshold {
			trend = "improving"
		} else if recentAvg < olderAvg-trendThreshold {
			trend = "declining"
		}
	}

	factorCorrelation := map[string]float64{}
	for _, factor := range wellnessMoodFactors {
		count := 0
		total := 0
		for _, e := range entries {
			if containsString(wellnessParseFactors(e.factors), factor) {
				total += e.mood
				count++
			}
		}
		if count > 0 {
			factorCorrelation[factor] = math.Round(float64(total)/float64(count)*10) / 10
		}
	}

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"average":           math.Round(average*10) / 10,
		"total":             len(entries),
		"streak":            streak,
		"trend":             trend,
		"factorCorrelation": factorCorrelation,
		"windowDays":        windowDays,
	}})
}

/* ------------------------------------------------------------------ *
 * Journal
 * ------------------------------------------------------------------ */

type wellnessJournalEntry struct {
	ID        string
	UserID    string
	Content   string
	AiSummary *string
	CreatedAt time.Time
}

func (e wellnessJournalEntry) json() map[string]any {
	return map[string]any{
		"id":        e.ID,
		"userId":    e.UserID,
		"content":   e.Content,
		"aiSummary": e.AiSummary,
		"createdAt": jsTimeValue(e.CreatedAt),
	}
}

func wellnessScanJournalEntry(scan func(dest ...any) error) (wellnessJournalEntry, error) {
	var e wellnessJournalEntry
	var aiSummary sql.NullString
	if err := scan(&e.ID, &e.UserID, &e.Content, &aiSummary, &e.CreatedAt); err != nil {
		return e, err
	}
	if aiSummary.Valid {
		e.AiSummary = &aiSummary.String
	}
	return e, nil
}

func (s *Server) handleWellnessCreateJournalEntry(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	content, msg := wellnessRequiredContentField(body)
	if msg != "" {
		s.validationFail(w, "body.content", msg)
		return
	}
	if msg := wellnessUnknownKeys(keys, "content"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}

	id := newID()
	now := time.Now().UTC()
	clean := s.wellnessSanitize(content)
	if _, err := s.DB.ExecContext(r.Context(),
		"INSERT INTO `JournalEntry` (id, userId, content, createdAt) VALUES (?,?,?,?)",
		id, user.ID, clean, now); err != nil {
		s.Log.Error("journal insert failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to save journal entry.")
		return
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{
		"id": id, "userId": user.ID, "content": clean, "aiSummary": nil, "createdAt": jsTimeValue(now),
	}})
}

func wellnessRequiredContentField(body map[string]any) (string, string) {
	v, exists := body["content"]
	if !exists {
		return "", "Invalid input: expected string, received undefined"
	}
	if v == nil {
		return "", "Invalid input: expected string, received null"
	}
	s, ok := v.(string)
	if !ok {
		return "", "Invalid input: expected string, received " + wellnessJSONType(v)
	}
	if wellnessJSLen(s) < 3 {
		return "", "Journal entry must be at least 3 characters"
	}
	if wellnessJSLen(s) > 10000 {
		return "", "Journal entry too long"
	}
	return s, ""
}

func (s *Server) handleWellnessGetJournalEntries(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	limit := 20
	if raw, present, multi := wellnessQueryRaw(r.URL.Query(), "limit"); present {
		if multi {
			s.validationFail(w, "query.limit", "Invalid input: expected number, received NaN")
			return
		}
		value, msg := wellnessQueryInt(raw, 1, 100, "Too small: expected number to be >=1", "Too big: expected number to be <=100")
		if msg != "" {
			s.validationFail(w, "query.limit", msg)
			return
		}
		limit = value
	}
	if limit > 100 {
		limit = 100
	}

	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, userId, content, aiSummary, createdAt FROM `JournalEntry` WHERE userId = ? ORDER BY createdAt DESC LIMIT ?",
		user.ID, limit)
	if err != nil {
		s.Log.Error("journal list failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to fetch journal entries.")
		return
	}
	defer rows.Close()

	entries := make([]map[string]any, 0)
	for rows.Next() {
		entry, err := wellnessScanJournalEntry(rows.Scan)
		if err != nil {
			s.Log.Error("journal list scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to fetch journal entries.")
			return
		}
		entries = append(entries, entry.json())
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("journal list rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to fetch journal entries.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": entries})
}

func (s *Server) handleWellnessUpdateJournalEntry(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	entryID, ok := s.wellnessIDParam(w, r)
	if !ok {
		return
	}
	body, keys, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	content, msg := wellnessRequiredContentField(body)
	if msg != "" {
		s.validationFail(w, "body.content", msg)
		return
	}
	if msg := wellnessUnknownKeys(keys, "content"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}

	entry, err := wellnessScanJournalEntry(func(dest ...any) error {
		return s.DB.QueryRowContext(r.Context(),
			"SELECT id, userId, content, aiSummary, createdAt FROM `JournalEntry` WHERE id = ?", entryID).Scan(dest...)
	})
	if err == sql.ErrNoRows || (err == nil && entry.UserID != user.ID) {
		s.Fail(w, http.StatusNotFound, "Journal entry not found")
		return
	}
	if err != nil {
		s.Log.Error("journal read failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to update journal entry.")
		return
	}

	clean := s.wellnessSanitize(content)
	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `JournalEntry` SET content = ? WHERE id = ?", clean, entryID); err != nil {
		s.Log.Error("journal update failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to update journal entry.")
		return
	}
	entry.Content = clean
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": entry.json()})
}

func (s *Server) handleWellnessDeleteJournalEntry(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	entryID, ok := s.wellnessIDParam(w, r)
	if !ok {
		return
	}

	var ownerID string
	err := s.DB.QueryRowContext(r.Context(), "SELECT userId FROM `JournalEntry` WHERE id = ?", entryID).Scan(&ownerID)
	if err == sql.ErrNoRows || (err == nil && ownerID != user.ID) {
		s.Fail(w, http.StatusNotFound, "Journal entry not found")
		return
	}
	if err != nil {
		s.Log.Error("journal read failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to delete journal entry.")
		return
	}

	if _, err := s.DB.ExecContext(r.Context(), "DELETE FROM `JournalEntry` WHERE id = ?", entryID); err != nil {
		s.Log.Error("journal delete failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to delete journal entry.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

func (s *Server) handleWellnessSummarizeJournal(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	if v, exists := body["entryId"]; exists {
		if v == nil {
			s.validationFail(w, "body.entryId", "Invalid input: expected string, received null")
			return
		}
		entryID, ok := v.(string)
		if !ok {
			s.validationFail(w, "body.entryId", "Invalid input: expected string, received "+wellnessJSONType(v))
			return
		}
		if !wellnessUUID7Pattern.MatchString(strings.ToLower(entryID)) {
			s.validationFail(w, "body.entryId", "Invalid id")
			return
		}
	}
	if msg := wellnessUnknownKeys(keys, "entryId"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}

	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT content FROM `JournalEntry` WHERE userId = ? ORDER BY createdAt DESC LIMIT 7", user.ID)
	if err != nil {
		s.Log.Error("journal summarize query failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to summarize journal.")
		return
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var content string
		if err := rows.Scan(&content); err != nil {
			s.Log.Error("journal summarize scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to summarize journal.")
			return
		}
		count++
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("journal summarize rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to summarize journal.")
		return
	}
	if count == 0 {
		s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
			"summary": nil,
			"count":   0,
		}})
		return
	}

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"summary": wellnessJournalSummaryFallback(count),
		"count":   count,
		"ai": map[string]any{
			"source":         "fallback",
			"degradedReason": s.wellnessAIDegradedReason(),
		},
	}})
}

func wellnessJournalSummaryFallback(count int) string {
	return fmt.Sprintf("You wrote %d journal entries this week — an excellent habit. ", count) +
		"Re-reading them later can reveal patterns in what lifts you up and what drains you. " +
		"Keep going, one entry at a time."
}

// wellnessAIDegradedReason mirrors the fallback provenance of ai.service.ts.
// The Go port never calls Gemini: an unset key is "not_configured" exactly like
// AIService.generate; a configured key is "error", because a model call would
// have been attempted in the Node service and this one serves the fallback.
func (s *Server) wellnessAIDegradedReason() string {
	if s.Cfg.GeminiAPIKey == "" {
		return "not_configured"
	}
	return "error"
}

/* ------------------------------------------------------------------ *
 * Assessments and the PHQ-9 item-9 rule
 * ------------------------------------------------------------------ */

var wellnessAssessmentQuestionCounts = map[string]int{"phq9": 9, "gad7": 7}

type wellnessBand struct {
	UpTo     int    `json:"upTo"`
	Severity string `json:"severity"`
}

type wellnessInstrument struct {
	Label string         `json:"label"`
	Max   int            `json:"max"`
	Bands []wellnessBand `json:"bands"`
}

var wellnessInstruments = map[string]wellnessInstrument{
	"phq9": {
		Label: "PHQ-9",
		Max:   27,
		Bands: []wellnessBand{
			{UpTo: 4, Severity: "minimal"},
			{UpTo: 9, Severity: "mild"},
			{UpTo: 14, Severity: "moderate"},
			{UpTo: 19, Severity: "moderately-severe"},
			{UpTo: 27, Severity: "severe"},
		},
	},
	"gad7": {
		Label: "GAD-7",
		Max:   21,
		Bands: []wellnessBand{
			{UpTo: 4, Severity: "minimal"},
			{UpTo: 9, Severity: "mild"},
			{UpTo: 14, Severity: "moderate"},
			{UpTo: 21, Severity: "severe"},
		},
	},
}

func wellnessSeverityFor(assessmentType string, score int) string {
	if assessmentType == "phq9" {
		switch {
		case score <= 4:
			return "minimal"
		case score <= 9:
			return "mild"
		case score <= 14:
			return "moderate"
		case score <= 19:
			return "moderately-severe"
		default:
			return "severe"
		}
	}
	switch {
	case score <= 4:
		return "minimal"
	case score <= 9:
		return "mild"
	case score <= 14:
		return "moderate"
	default:
		return "severe"
	}
}

var wellnessRiskAnswerLabels = []string{"not at all", "several days", "more than half the days", "nearly every day"}

// wellnessDetectAssessmentRisk ports clinicalSafety.service.ts's item-9 rule:
// a non-zero answer to PHQ-9 item 9 (index 8) is a disclosure.
func wellnessDetectAssessmentRisk(assessmentType string, answers []int) (level, reason string, ok bool) {
	if assessmentType != "phq9" || len(answers) <= 8 {
		return "", "", false
	}
	selfHarm := answers[8]
	if selfHarm <= 0 {
		return "", "", false
	}
	level = "elevated"
	if selfHarm >= 2 {
		level = "urgent"
	}
	label := fmt.Sprintf("%d", selfHarm)
	if selfHarm >= 0 && selfHarm < len(wellnessRiskAnswerLabels) {
		label = wellnessRiskAnswerLabels[selfHarm]
	}
	reason = fmt.Sprintf(`PHQ-9 item 9 (thoughts of self-harm or death) answered "%s".`, label)
	return level, reason, true
}

func wellnessDescribeDirection(totalChange *int, sittings int) string {
	if totalChange == nil || sittings < 3 {
		return "insufficient-data"
	}
	if *totalChange <= -3 {
		return "improving"
	}
	if *totalChange >= 3 {
		return "worsening"
	}
	return "stable"
}

type wellnessAssessment struct {
	ID          string
	UserID      string
	Type        string
	AnswersJSON string
	Score       int
	Severity    string
	CreatedAt   time.Time
}

func (a wellnessAssessment) json() map[string]any {
	return map[string]any{
		"id":          a.ID,
		"userId":      a.UserID,
		"type":        a.Type,
		"answersJson": a.AnswersJSON,
		"score":       a.Score,
		"severity":    a.Severity,
		"createdAt":   jsTimeValue(a.CreatedAt),
	}
}

func wellnessScanAssessment(scan func(dest ...any) error) (wellnessAssessment, error) {
	var a wellnessAssessment
	err := scan(&a.ID, &a.UserID, &a.Type, &a.AnswersJSON, &a.Score, &a.Severity, &a.CreatedAt)
	return a, err
}

func (s *Server) handleWellnessSubmitAssessment(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	assessmentType, msg := wellnessEnumField(body, "type", wellnessAssessmentTypes, "Assessment type must be phq9 or gad7")
	if msg != "" {
		s.validationFail(w, "body.type", msg)
		return
	}
	answers, msg, path := wellnessAnswersField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}
	if msg := wellnessUnknownKeys(keys, "type", "answers"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}

	questionCount := wellnessAssessmentQuestionCounts[assessmentType]
	if len(answers) != questionCount {
		s.Fail(w, http.StatusBadRequest, fmt.Sprintf("Assessment requires exactly %d answers", questionCount))
		return
	}
	for _, a := range answers {
		if a < 0 || a > 3 {
			s.Fail(w, http.StatusBadRequest, "Each answer must be an integer between 0 and 3")
			return
		}
	}

	score := 0
	for _, a := range answers {
		score += a
	}
	severity := wellnessSeverityFor(assessmentType, score)
	answersJSON, _ := json.Marshal(answers)

	assessment := wellnessAssessment{
		ID:          newID(),
		UserID:      user.ID,
		Type:        assessmentType,
		AnswersJSON: string(answersJSON),
		Score:       score,
		Severity:    severity,
		CreatedAt:   time.Now().UTC(),
	}
	if _, err := s.DB.ExecContext(r.Context(),
		"INSERT INTO `Assessment` (id, userId, type, answersJson, score, severity, createdAt) VALUES (?,?,?,?,?,?,?)",
		assessment.ID, assessment.UserID, assessment.Type, assessment.AnswersJSON, assessment.Score, assessment.Severity, assessment.CreatedAt); err != nil {
		s.Log.Error("assessment insert failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to submit assessment.")
		return
	}

	ctx := r.Context()
	data := assessment.json()

	level, reason, risky := wellnessDetectAssessmentRisk(assessmentType, answers)
	if !risky {
		data["risk"] = wellnessRiskSignal(false, nil, nil, false, true, nil)
		s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": data})
		return
	}

	var userName *string
	var name sql.NullString
	if err := s.DB.QueryRowContext(ctx, "SELECT name FROM `User` WHERE id = ?", user.ID).Scan(&name); err == nil && name.Valid {
		userName = &name.String
	}

	signal := s.clinicalRaiseRiskAlert(ctx, clinicalRiskInput{
		UserID:     user.ID,
		UserName:   userName,
		Level:      level,
		Reason:     reason,
		SourceType: assessmentType,
		SourceID:   &assessment.ID,
	})
	data["risk"] = signal
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": data})
}

func (s *Server) handleWellnessGetAssessments(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	query := r.URL.Query()

	typeFilter := ""
	if raw, present, multi := wellnessQueryRaw(query, "type"); present {
		if multi || !containsString(wellnessAssessmentTypes, raw) {
			s.validationFail(w, "query.type", `Invalid option: expected one of "phq9"|"gad7"`)
			return
		}
		typeFilter = raw
	}
	limit := 10
	if raw, present, multi := wellnessQueryRaw(query, "limit"); present {
		if multi {
			s.validationFail(w, "query.limit", "Invalid input: expected number, received NaN")
			return
		}
		value, msg := wellnessQueryInt(raw, 1, 100, "Too small: expected number to be >=1", "Too big: expected number to be <=100")
		if msg != "" {
			s.validationFail(w, "query.limit", msg)
			return
		}
		limit = value
	}
	if limit > 100 {
		limit = 100
	}

	sqlText := "SELECT id, userId, type, answersJson, score, severity, createdAt FROM `Assessment` WHERE userId = ?"
	args := []any{user.ID}
	if typeFilter != "" {
		sqlText += " AND type = ?"
		args = append(args, typeFilter)
	}
	sqlText += " ORDER BY createdAt DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.DB.QueryContext(r.Context(), sqlText, args...)
	if err != nil {
		s.Log.Error("assessment list failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to fetch assessments.")
		return
	}
	defer rows.Close()

	assessments := make([]map[string]any, 0)
	for rows.Next() {
		assessment, err := wellnessScanAssessment(rows.Scan)
		if err != nil {
			s.Log.Error("assessment list scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to fetch assessments.")
			return
		}
		assessments = append(assessments, assessment.json())
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("assessment list rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to fetch assessments.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": assessments})
}

type wellnessTrajectoryPoint struct {
	ID                 string `json:"id"`
	Score              int    `json:"score"`
	Severity           string `json:"severity"`
	CreatedAt          JSTime `json:"createdAt"`
	ChangeFromPrevious *int   `json:"changeFromPrevious"`
}

type wellnessTrajectorySummary struct {
	Sittings    int    `json:"sittings"`
	First       *int   `json:"first"`
	Latest      *int   `json:"latest"`
	TotalChange *int   `json:"totalChange"`
	Direction   string `json:"direction"`
}

func (s *Server) handleWellnessAssessmentTrajectory(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	query := r.URL.Query()

	assessmentType := ""
	if raw, present, multi := wellnessQueryRaw(query, "type"); !present || multi || !containsString(wellnessAssessmentTypes, raw) {
		s.validationFail(w, "query.type", `Invalid option: expected one of "phq9"|"gad7"`)
		return
	} else {
		assessmentType = raw
	}
	limit := 24
	if raw, present, multi := wellnessQueryRaw(query, "limit"); present {
		if multi {
			s.validationFail(w, "query.limit", "Invalid input: expected number, received NaN")
			return
		}
		value, msg := wellnessQueryInt(raw, 2, 100, "Too small: expected number to be >=2", "Too big: expected number to be <=100")
		if msg != "" {
			s.validationFail(w, "query.limit", msg)
			return
		}
		limit = value
	}
	if limit > 100 {
		limit = 100
	}

	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, score, severity, createdAt FROM `Assessment` WHERE userId = ? AND type = ? ORDER BY createdAt DESC LIMIT ?",
		user.ID, assessmentType, limit)
	if err != nil {
		s.Log.Error("trajectory query failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to fetch the assessment trajectory.")
		return
	}
	defer rows.Close()

	type sitting struct {
		id        string
		score     int
		severity  string
		createdAt time.Time
	}
	newest := make([]sitting, 0)
	for rows.Next() {
		var row sitting
		if err := rows.Scan(&row.id, &row.score, &row.severity, &row.createdAt); err != nil {
			s.Log.Error("trajectory scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to fetch the assessment trajectory.")
			return
		}
		newest = append(newest, row)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("trajectory rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to fetch the assessment trajectory.")
		return
	}

	points := make([]wellnessTrajectoryPoint, 0, len(newest))
	for i := len(newest) - 1; i >= 0; i-- {
		row := newest[i]
		var change *int
		if i < len(newest)-1 {
			delta := row.score - newest[i+1].score
			change = &delta
		}
		points = append(points, wellnessTrajectoryPoint{
			ID:                 row.id,
			Score:              row.score,
			Severity:           row.severity,
			CreatedAt:          jsTimeValue(row.createdAt),
			ChangeFromPrevious: change,
		})
	}

	var first, latest, totalChange *int
	if len(points) > 0 {
		firstValue := points[0].Score
		latestValue := points[len(points)-1].Score
		first = &firstValue
		latest = &latestValue
		change := latestValue - firstValue
		totalChange = &change
	}

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"type":       assessmentType,
		"instrument": wellnessInstruments[assessmentType],
		"points":     points,
		"summary": wellnessTrajectorySummary{
			Sittings:    len(points),
			First:       first,
			Latest:      latest,
			TotalChange: totalChange,
			Direction:   wellnessDescribeDirection(totalChange, len(points)),
		},
	}})
}

/* ------------------------------------------------------------------ *
 * Risk queue (riskQueue.service.ts + clinicalSafety.controller.ts)
 * ------------------------------------------------------------------ */

func wellnessPriorityFor(level string, acknowledgedAt *time.Time) int {
	byLevel := 2
	switch level {
	case "urgent":
		byLevel = 0
	case "elevated":
		byLevel = 1
	}
	byAck := 0
	if acknowledgedAt != nil {
		byAck = 1
	}
	p := byLevel*2 + byAck
	if p > 3 {
		p = 3
	}
	return p
}

var wellnessUrgencyLabels = []string{
	"urgent-unacknowledged",
	"urgent-acknowledged",
	"elevated-unacknowledged",
	"elevated-acknowledged",
}

type wellnessRiskQueueItem struct {
	ID               string
	Priority         int
	Urgency          string
	Level            string
	Reason           string
	SourceType       string
	SourceID         *string
	CreatedAt        time.Time
	AcknowledgedAt   *time.Time
	AcknowledgedByID *string
	ResolutionNote   *string
	ResolvedAt       *time.Time
	ResolvedByID     *string
	PatientID        string
	PatientName      *string
	PatientEmail     string
	LastAssessment   map[string]any
}

func (i wellnessRiskQueueItem) json() map[string]any {
	return map[string]any{
		"id":               i.ID,
		"priority":         i.Priority,
		"urgency":          i.Urgency,
		"level":            i.Level,
		"reason":           i.Reason,
		"sourceType":       i.SourceType,
		"sourceId":         i.SourceID,
		"createdAt":        jsTimeValue(i.CreatedAt),
		"acknowledgedAt":   jsTime(i.AcknowledgedAt),
		"acknowledgedById": i.AcknowledgedByID,
		"resolutionNote":   i.ResolutionNote,
		"resolvedAt":       jsTime(i.ResolvedAt),
		"resolvedById":     i.ResolvedByID,
		"patient": map[string]any{
			"id":             i.PatientID,
			"name":           i.PatientName,
			"email":          i.PatientEmail,
			"lastAssessment": i.LastAssessment,
		},
	}
}

func (s *Server) handleWellnessListRiskAlerts(w http.ResponseWriter, r *http.Request) {
	actor := CurrentUser(r)
	includeResolved := r.URL.Query().Get("includeResolved") == "true"

	query := "SELECT ra.id, ra.level, ra.reason, ra.sourceType, ra.sourceId, ra.createdAt, " +
		"ra.acknowledgedAt, ra.acknowledgedById, ra.resolutionNote, ra.resolvedAt, ra.resolvedById, " +
		"u.id, u.name, u.email, a.type, a.score, a.severity, a.createdAt " +
		"FROM `RiskAlert` ra JOIN `User` u ON u.id = ra.userId " +
		"LEFT JOIN `Assessment` a ON a.id = (SELECT a2.id FROM `Assessment` a2 WHERE a2.userId = ra.userId ORDER BY a2.createdAt DESC LIMIT 1)"
	var where []string
	var args []any
	if !includeResolved {
		where = append(where, "ra.resolvedAt IS NULL")
	}
	if actor.Role != "admin" {
		where = append(where, "(ra.assignedDoctorUserId = ? OR (ra.assignedDoctorUserId IS NULL AND EXISTS ("+
			"SELECT 1 FROM `Appointment` ap JOIN `Doctor` d ON d.id = ap.doctorId "+
			"WHERE ap.userId = ra.userId AND ap.status IN ('confirmed','completed') AND d.userId = ?)))")
		args = append(args, actor.ID, actor.ID)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY ra.createdAt DESC LIMIT 200"

	rows, err := s.DB.QueryContext(r.Context(), query, args...)
	if err != nil {
		s.Log.Error("risk queue query failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to load the risk queue.")
		return
	}
	defer rows.Close()

	items := make([]wellnessRiskQueueItem, 0)
	for rows.Next() {
		var (
			item                       wellnessRiskQueueItem
			assessType, assessSeverity *string
			assessScore                *int
			assessCreatedAt            *time.Time
		)
		if err := rows.Scan(
			&item.ID, &item.Level, &item.Reason, &item.SourceType, &item.SourceID, &item.CreatedAt,
			&item.AcknowledgedAt, &item.AcknowledgedByID, &item.ResolutionNote, &item.ResolvedAt, &item.ResolvedByID,
			&item.PatientID, &item.PatientName, &item.PatientEmail,
			&assessType, &assessScore, &assessSeverity, &assessCreatedAt,
		); err != nil {
			s.Log.Error("risk queue scan failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Failed to load the risk queue.")
			return
		}
		item.Priority = wellnessPriorityFor(item.Level, item.AcknowledgedAt)
		item.Urgency = wellnessUrgencyLabels[item.Priority]
		if assessType != nil && assessScore != nil && assessSeverity != nil && assessCreatedAt != nil {
			item.LastAssessment = map[string]any{
				"type":      *assessType,
				"score":     *assessScore,
				"severity":  *assessSeverity,
				"createdAt": jsTimeValue(*assessCreatedAt),
			}
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		s.Log.Error("risk queue rows failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to load the risk queue.")
		return
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Priority != items[j].Priority {
			return items[i].Priority < items[j].Priority
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})

	counts := map[string]any{
		"unresolved":           0,
		"unacknowledged":       0,
		"urgentUnacknowledged": 0,
	}
	open, unack, urgentUnack := 0, 0, 0
	for _, item := range items {
		if item.ResolvedAt != nil {
			continue
		}
		open++
		if item.AcknowledgedAt == nil {
			unack++
			if item.Level == "urgent" {
				urgentUnack++
			}
		}
	}
	counts["unresolved"] = open
	counts["unacknowledged"] = unack
	counts["urgentUnacknowledged"] = urgentUnack

	// Reading the queue is reading every disclosure on it: one access-log row
	// per item, carrying who read whose record.
	actorID := actor.ID
	targetType := "RiskAlert"
	for i := range items {
		s.audit(r.Context(), "clinical.read", &actorID, &targetType, &items[i].ID, map[string]any{
			"subjectId": items[i].PatientID,
			"via":       "GET /api/wellness/risk-alerts",
		})
	}

	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, item.json())
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": out, "counts": counts})
}

func (s *Server) clinicalTreatsPatient(ctx context.Context, doctorUserID, patientUserID string) (bool, error) {
	var one int
	err := s.DB.QueryRowContext(ctx,
		"SELECT 1 FROM `Appointment` ap JOIN `Doctor` d ON d.id = ap.doctorId "+
			"WHERE ap.userId = ? AND ap.status IN ('confirmed','completed') AND d.userId = ? LIMIT 1",
		patientUserID, doctorUserID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Server) clinicalCanTriage(ctx context.Context, actor *UserCtx, patientID string, assignedDoctorUserID *string) (bool, error) {
	if actor.Role == "admin" {
		return true, nil
	}
	if assignedDoctorUserID != nil && *assignedDoctorUserID == actor.ID {
		return true, nil
	}
	return s.clinicalTreatsPatient(ctx, actor.ID, patientID)
}

func (s *Server) handleWellnessAcknowledgeRiskAlert(w http.ResponseWriter, r *http.Request) {
	actor := CurrentUser(r)
	alertID, ok := s.wellnessIDParam(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var (
		patientID string
		assigned  *string
		ackedAt   *time.Time
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT userId, assignedDoctorUserId, acknowledgedAt FROM `RiskAlert` WHERE id = ?", alertID).
		Scan(&patientID, &assigned, &ackedAt)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Alert not found")
		return
	}
	if err != nil {
		s.Log.Error("risk alert read failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to acknowledge the alert.")
		return
	}

	allowed, err := s.clinicalCanTriage(ctx, actor, patientID, assigned)
	if err != nil {
		s.Log.Error("risk triage check failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to acknowledge the alert.")
		return
	}
	if !allowed {
		s.Fail(w, http.StatusForbidden, "not your patient")
		return
	}
	if ackedAt != nil {
		s.Fail(w, http.StatusBadRequest, "This alert has already been acknowledged")
		return
	}

	now := time.Now().UTC()
	res, err := s.DB.ExecContext(ctx,
		"UPDATE `RiskAlert` SET acknowledgedAt = ?, acknowledgedById = ? WHERE id = ? AND acknowledgedAt IS NULL",
		now, actor.ID, alertID)
	if err != nil {
		s.Log.Error("risk acknowledge failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to acknowledge the alert.")
		return
	}
	if affected, _ := res.RowsAffected(); affected != 1 {
		s.Fail(w, http.StatusBadRequest, "This alert has already been acknowledged")
		return
	}

	var storedAt *time.Time
	var storedBy *string
	if err := s.DB.QueryRowContext(ctx,
		"SELECT acknowledgedAt, acknowledgedById FROM `RiskAlert` WHERE id = ?", alertID).
		Scan(&storedAt, &storedBy); err != nil {
		s.Log.Error("risk acknowledge read-back failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to acknowledge the alert.")
		return
	}

	s.audit(ctx, "risk.acknowledged", &actor.ID, ptr("RiskAlert"), &alertID, map[string]any{"userId": patientID})
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"id":               alertID,
		"acknowledgedAt":   jsTime(storedAt),
		"acknowledgedById": storedBy,
	}})
}

func (s *Server) handleWellnessResolveRiskAlert(w http.ResponseWriter, r *http.Request) {
	actor := CurrentUser(r)
	alertID, ok := s.wellnessIDParam(w, r)
	if !ok {
		return
	}
	body, keys, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	note, msg := wellnessOptionalStringField(body, "note", 1000, "Note too long")
	if msg != "" {
		s.validationFail(w, "body.note", msg)
		return
	}
	if msg := wellnessUnknownKeys(keys, "note"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}
	var trimmedNote *string
	if note != nil {
		trimmed := strings.TrimSpace(*note)
		trimmedNote = &trimmed
	}

	ctx := r.Context()
	var (
		patientID string
		assigned  *string
		ackedAt   *time.Time
		resolved  *time.Time
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT userId, assignedDoctorUserId, acknowledgedAt, resolvedAt FROM `RiskAlert` WHERE id = ?", alertID).
		Scan(&patientID, &assigned, &ackedAt, &resolved)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Alert not found")
		return
	}
	if err != nil {
		s.Log.Error("risk alert read failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to resolve the alert.")
		return
	}

	allowed, err := s.clinicalCanTriage(ctx, actor, patientID, assigned)
	if err != nil {
		s.Log.Error("risk triage check failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to resolve the alert.")
		return
	}
	if !allowed {
		s.Fail(w, http.StatusForbidden, "not your patient")
		return
	}
	if resolved != nil {
		s.Fail(w, http.StatusBadRequest, "This alert has already been resolved")
		return
	}

	now := time.Now().UTC()
	var res sql.Result
	if trimmedNote != nil && *trimmedNote != "" {
		res, err = s.DB.ExecContext(ctx,
			"UPDATE `RiskAlert` SET resolvedAt = ?, resolvedById = ?, resolutionNote = ? WHERE id = ? AND resolvedAt IS NULL",
			now, actor.ID, *trimmedNote, alertID)
	} else {
		res, err = s.DB.ExecContext(ctx,
			"UPDATE `RiskAlert` SET resolvedAt = ?, resolvedById = ? WHERE id = ? AND resolvedAt IS NULL",
			now, actor.ID, alertID)
	}
	if err != nil {
		s.Log.Error("risk resolve failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to resolve the alert.")
		return
	}
	if affected, _ := res.RowsAffected(); affected != 1 {
		s.Fail(w, http.StatusBadRequest, "This alert has already been resolved")
		return
	}

	// Resolving implies seeing: fill the acknowledgement only if it is still
	// empty, so a concurrent acknowledgement is never overwritten.
	if ackedAt == nil {
		_, _ = s.DB.ExecContext(ctx,
			"UPDATE `RiskAlert` SET acknowledgedAt = ?, acknowledgedById = ? WHERE id = ? AND acknowledgedAt IS NULL",
			now, actor.ID, alertID)
	}

	var (
		storedResolved *time.Time
		storedBy       *string
		storedNote     *string
	)
	if err := s.DB.QueryRowContext(ctx,
		"SELECT resolvedAt, resolvedById, resolutionNote FROM `RiskAlert` WHERE id = ?", alertID).
		Scan(&storedResolved, &storedBy, &storedNote); err != nil {
		s.Log.Error("risk resolve read-back failed", "err", err)
		s.Fail(w, http.StatusInternalServerError, "Failed to resolve the alert.")
		return
	}

	var auditNote any
	if trimmedNote != nil {
		auditNote = *trimmedNote
	}
	s.audit(ctx, "risk.resolved", &actor.ID, ptr("RiskAlert"), &alertID, map[string]any{
		"userId":                 patientID,
		"note":                   auditNote,
		"impliedAcknowledgement": ackedAt == nil,
	})
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"id":             alertID,
		"resolvedAt":     jsTime(storedResolved),
		"resolvedById":   storedBy,
		"resolutionNote": storedNote,
	}})
}

/* ------------------------------------------------------------------ *
 * Crisis text classification (crisisText.service.ts)
 * ------------------------------------------------------------------ */

var clinicalCrisisPatterns = []*regexp.Regexp{
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

var clinicalThirdPartyPattern = regexp.MustCompile(`(?i)\b(my (friend|brother|sister|partner|husband|wife|son|daughter|mother|father|roommate|colleague|coworker|boss))\b`)

var clinicalEscalationPattern = regexp.MustCompile(`(?i)(human|agent|customer\s*service|real\s*person|talk\s*to\s*someone|support\s*team|contact\s*support|orang\s*asli|petugas|manusia|tim\s*dukung|hubungi\s*cs)`)

type clinicalFreeTextRisk struct {
	Level              string
	MatchedText        string
	Reason             string
	MentionsThirdParty bool
}

// clinicalDetectFreeTextRisk is deterministic and never leaves the server. A
// third-party mention is informational and never suppresses the alert.
func clinicalDetectFreeTextRisk(content string) *clinicalFreeTextRisk {
	if content == "" {
		return nil
	}
	for _, pattern := range clinicalCrisisPatterns {
		match := pattern.FindString(content)
		if match == "" {
			continue
		}
		mentionsThirdParty := clinicalThirdPartyPattern.MatchString(content)
		context := ""
		if mentionsThirdParty {
			context = " The message also mentions another person, so it may partly be about them rather than about the patient; the clinician decides which."
		}
		return &clinicalFreeTextRisk{
			Level:              "urgent",
			MatchedText:        match,
			MentionsThirdParty: mentionsThirdParty,
			Reason: fmt.Sprintf(
				`Free-text message matched the crisis pattern "%s". This is a keyword match, not a clinical assessment - it is a prompt for a clinician to read the message and decide.%s`,
				match, context),
		}
	}
	return nil
}

/* ------------------------------------------------------------------ *
 * Crisis hotlines
 * ------------------------------------------------------------------ */

type clinicalCrisisHotline struct {
	Name     string `json:"name"`
	Dial     string `json:"dial"`
	Contact  string `json:"contact"`
	WhatsApp bool   `json:"whatsapp"`
}

var clinicalCrisisHotlines = []clinicalCrisisHotline{
	{Name: "Emergency (Indonesia)", Dial: "112", Contact: "112 / 119", WhatsApp: false},
	{Name: "Kemenkes SEJIWA", Dial: "119", Contact: "119 ext 8", WhatsApp: false},
	{Name: "Halo Kemenkes", Dial: "1500567", Contact: "1500-567", WhatsApp: false},
	{Name: "Into The Light (WhatsApp)", Dial: "628121232012", Contact: "+62 812-123-2012", WhatsApp: true},
}

/* ------------------------------------------------------------------ *
 * Realtime events, notifications and out-of-band channels
 * ------------------------------------------------------------------ */

// wellnessPublishEvent ports realtime.service.ts's publishEvent: publish on
// `mindease:events`, swallow failures (the Node publisher never rejects, so the
// caller's delivery accounting treats realtime as best effort).
func (s *Server) wellnessPublishEvent(ctx context.Context, userID, eventType string, payload map[string]any) {
	if s.Cfg.IsTest || s.Redis == nil {
		return
	}
	envelope := map[string]any{"userId": userID, "type": eventType, "payload": payload}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := s.Redis.Publish(publishCtx, "mindease:events", string(raw)).Err(); err != nil {
		s.Log.Warn("failed to publish realtime event", "err", err, "type", eventType)
	}
}

type wellnessChannelPrefs struct {
	InApp bool
	Email bool
}

func wellnessDefaultPrefs() map[string]wellnessChannelPrefs {
	return map[string]wellnessChannelPrefs{
		"appointment": {InApp: true, Email: false},
		"message":     {InApp: true, Email: false},
		"system":      {InApp: true, Email: true},
	}
}

func wellnessParsePrefs(raw *string) map[string]wellnessChannelPrefs {
	result := wellnessDefaultPrefs()
	if raw == nil || *raw == "" {
		return result
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return result
	}
	for _, notificationType := range []string{"appointment", "message", "system"} {
		value, ok := parsed[notificationType]
		if !ok {
			continue
		}
		switch v := value.(type) {
		case bool:
			current := result[notificationType]
			current.InApp = v
			result[notificationType] = current
		case map[string]any:
			inApp := true
			if b, ok := v["inApp"].(bool); ok && !b {
				inApp = false
			}
			email := false
			if b, ok := v["email"].(bool); ok && b {
				email = true
			}
			result[notificationType] = wellnessChannelPrefs{InApp: inApp, Email: email}
		}
	}
	return result
}

// wellnessNotifyCreate ports NotificationService.create: channel preferences,
// the in-app row, the realtime ping and a best-effort email. The web push
// channel is not ported (no push client in this binary).
func (s *Server) wellnessNotifyCreate(ctx context.Context, userID, title, message, notificationType string, withEmail bool) error {
	if notificationType == "" {
		notificationType = "system"
	}
	prefs := wellnessDefaultPrefs()
	if containsString([]string{"appointment", "message", "system"}, notificationType) {
		var (
			rawPrefs *string
			email    string
		)
		err := s.DB.QueryRowContext(ctx,
			"SELECT notificationPrefs, email FROM `User` WHERE id = ?", userID).Scan(&rawPrefs, &email)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if err == nil {
			prefs = wellnessParsePrefs(rawPrefs)
		}
		channel := prefs[notificationType]
		if !channel.InApp && !(withEmail && channel.Email) {
			return nil
		}
		if withEmail && channel.Email && email != "" {
			subject, html := wellnessBuildNotificationEmail(title, message)
			recipient := email
			go func() {
				mailCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := s.wellnessMailerSend(mailCtx, recipient, subject, html); err != nil {
					s.Log.Error("notification email failed", "err", err)
				}
			}()
		}
	}
	if !prefs[notificationType].InApp {
		return nil
	}

	cleanTitle := strings.TrimSpace(s.Sanitizer.Sanitize(title))
	cleanMessage := strings.TrimSpace(s.Sanitizer.Sanitize(message))
	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), userID, cleanTitle, cleanMessage, false, notificationType, now); err != nil {
		return err
	}
	s.wellnessPublishEvent(ctx, userID, "notification:new", map[string]any{
		"title":     cleanTitle,
		"message":   cleanMessage,
		"type":      notificationType,
		"createdAt": now.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	return nil
}

func wellnessEsc(v string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return replacer.Replace(v)
}

func wellnessBuildNotificationEmail(title, message string) (string, string) {
	subject := wellnessEsc(title) + " — MindEase"
	html := `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p style="font-weight:bold;margin:0 0 8px">` + wellnessEsc(title) + `</p>
  <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:8px 0">
    <p style="margin:0;color:#475569">` + wellnessEsc(message) + `</p>
  </div>
  <p style="color:#64748b;font-size:13px">Open your dashboard to view details. You can adjust these email notifications anytime in Profile — Notification preferences.</p>
</div>`
	return subject, html
}

func wellnessScrubForLog(v string) string {
	mapped := strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r < 0x20 || r == 0x7F {
			return ' '
		}
		return r
	}, v)
	if wellnessJSLen(mapped) > 200 {
		return wellnessSliceJS(mapped, 200) + "..."
	}
	return mapped
}

func wellnessEnvelopeFrom(from string) string {
	if i := strings.LastIndex(from, "<"); i >= 0 {
		if j := strings.Index(from[i:], ">"); j > 0 {
			return strings.TrimSpace(from[i+1 : i+j])
		}
	}
	return strings.TrimSpace(from)
}

// wellnessMailerSend mirrors mailer.service.ts: SMTP when configured, a
// logged dev fallback outside production, and a loud failure in production.
func (s *Server) wellnessMailerSend(ctx context.Context, to, subject, htmlBody string) error {
	host := strings.TrimSpace(os.Getenv("SMTP_HOST"))
	if host == "" {
		if s.Cfg.IsProd {
			return errors.New("SMTP is not configured (SMTP_HOST missing) but NODE_ENV=production")
		}
		s.Log.Warn("[MAIL] SMTP not configured; no message was sent", "to", wellnessScrubForLog(to), "subject", wellnessScrubForLog(subject))
		return nil
	}
	port := strings.TrimSpace(os.Getenv("SMTP_PORT"))
	if port == "" {
		port = "587"
	}
	secure := os.Getenv("SMTP_SECURE") == "true"
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	from := strings.TrimSpace(os.Getenv("SMTP_FROM"))
	if from == "" {
		from = "MindEase <no-reply@mindease.app>"
	}
	fromAddr := wellnessEnvelopeFrom(from)

	message := []byte("From: " + wellnessScrubForLog(from) + "\r\n" +
		"To: " + wellnessScrubForLog(to) + "\r\n" +
		"Subject: " + wellnessScrubForLog(subject) + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/html; charset=UTF-8\r\n" +
		"Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n" +
		"\r\n" + htmlBody)

	addr := net.JoinHostPort(host, port)
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	if secure {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: host})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer client.Close()

	if !secure {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: host}); err != nil {
				return err
			}
		}
	}
	if user != "" {
		if err := client.Auth(smtp.PlainAuth("", user, pass, host)); err != nil {
			return err
		}
	}
	if err := client.Mail(fromAddr); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(message); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func wellnessNormalizePhone(phone string) string {
	var builder strings.Builder
	for _, r := range phone {
		if r >= '0' && r <= '9' {
			builder.WriteRune(r)
		}
	}
	digits := builder.String()
	if strings.HasPrefix(digits, "0") {
		return "62" + digits[1:]
	}
	if strings.HasPrefix(digits, "8") {
		return "62" + digits
	}
	return digits
}

// wellnessWhatsAppSend mirrors wa.service.ts: no-op and false when the gateway
// is unconfigured, false on any error.
func (s *Server) wellnessWhatsAppSend(ctx context.Context, to, message string) bool {
	gatewayURL := strings.TrimSpace(os.Getenv("WA_GATEWAY_URL"))
	token := strings.TrimSpace(os.Getenv("WA_GATEWAY_TOKEN"))
	if gatewayURL == "" || token == "" {
		if !s.Cfg.IsProd {
			s.Log.Info("[WA] gateway not configured", "to", wellnessScrubForLog(to))
		}
		return false
	}
	payload, err := json.Marshal(map[string]any{"target": wellnessNormalizePhone(to), "message": message})
	if err != nil {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, gatewayURL, strings.NewReader(string(payload)))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		s.Log.Warn("WhatsApp gateway unreachable", "err", err)
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		s.Log.Warn("WhatsApp gateway returned an error", "status", resp.StatusCode)
		return false
	}
	return true
}

/* ------------------------------------------------------------------ *
 * Risk escalation (clinicalSafety.service.ts raiseRiskAlert)
 * ------------------------------------------------------------------ */

type clinicalRiskInput struct {
	UserID     string
	UserName   *string
	Level      string
	Reason     string
	SourceType string
	SourceID   *string
}

func wellnessRiskSignal(riskFlag bool, level, reason any, clinicianNotified, recorded bool, alertID *string) map[string]any {
	return map[string]any{
		"riskFlag":          riskFlag,
		"level":             level,
		"reason":            reason,
		"hotlines":          clinicalCrisisHotlines,
		"crisisPage":        "/crisis",
		"clinicianNotified": clinicianNotified,
		"recorded":          recorded,
		"alertId":           alertID,
	}
}

// clinicalRaiseRiskAlert records a disclosure and pages the patient's assigned
// clinician; every channel is isolated, and `recorded` reports whether the
// durable RiskAlert row exists independently of whether anyone was reached.
func (s *Server) clinicalRaiseRiskAlert(ctx context.Context, input clinicalRiskInput) map[string]any {
	var (
		doctorUserID string
		doctorName   sql.NullString
	)
	appointmentErr := s.DB.QueryRowContext(ctx,
		"SELECT d.userId, u.name FROM `Appointment` ap "+
			"JOIN `Doctor` d ON d.id = ap.doctorId JOIN `User` u ON u.id = d.userId "+
			"WHERE ap.userId = ? AND ap.status IN ('confirmed','completed') "+
			"ORDER BY ap.appointmentDate DESC LIMIT 1",
		input.UserID).Scan(&doctorUserID, &doctorName)
	hasAppointment := appointmentErr == nil
	if appointmentErr != nil && appointmentErr != sql.ErrNoRows {
		s.Log.Error("risk alert appointment lookup failed", "err", appointmentErr)
	}

	var assignedDoctorUserID any
	if hasAppointment {
		assignedDoctorUserID = doctorUserID
	}

	alertID := newID()
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `RiskAlert` (id, userId, level, reason, sourceType, sourceId, assignedDoctorUserId, createdAt) VALUES (?,?,?,?,?,?,?,?)",
		alertID, input.UserID, input.Level, input.Reason,
		input.SourceType, input.SourceID, assignedDoctorUserID, time.Now().UTC())
	recorded := err == nil
	if !recorded {
		s.Log.Error("failed to persist risk alert", "err", err, "userId", input.UserID)
		alertID = ""
	}

	var alertIDValue *string
	if recorded {
		alertIDValue = &alertID
	}

	if !hasAppointment {
		s.audit(ctx, "risk.raised", &input.UserID, nil, nil, map[string]any{
			"level":             input.Level,
			"sourceType":        input.SourceType,
			"clinicianNotified": false,
			"recorded":          recorded,
		})
		s.Log.Warn("risk disclosure with no assigned clinician", "userId", input.UserID, "level", input.Level)
		return wellnessRiskSignal(true, input.Level, input.Reason, false, recorded, alertIDValue)
	}

	name := "A patient"
	if input.UserName != nil && *input.UserName != "" {
		name = *input.UserName
	}

	title := "Risk disclosure from a patient"
	if input.Level == "urgent" {
		title = "Urgent risk disclosure from a patient"
	}
	clinicianMessage := fmt.Sprintf(
		"%s reported thoughts of self-harm or death on a screening questionnaire (%s). Please reach out to them today.",
		name, input.Level)

	clinicianReached := false
	if err := s.wellnessNotifyCreate(ctx, doctorUserID, title, clinicianMessage, "system", true); err != nil {
		s.Log.Error("risk escalation in-app channel failed", "err", err, "channel", "inapp", "userId", input.UserID)
	} else {
		clinicianReached = true
	}

	s.wellnessPublishEvent(ctx, doctorUserID, "risk:alert", map[string]any{
		"patientName": name,
		"level":       input.Level,
		"alertId":     alertIDValue,
	})

	adminRows, adminErr := s.DB.QueryContext(ctx,
		"SELECT id FROM `User` WHERE role = 'admin' AND isBanned = 0 LIMIT 5")
	if adminErr != nil {
		s.Log.Error("risk escalation admin channel failed", "err", adminErr, "channel", "admin", "userId", input.UserID)
	} else {
		adminIDs := make([]string, 0, 5)
		for adminRows.Next() {
			var adminID string
			if err := adminRows.Scan(&adminID); err == nil {
				adminIDs = append(adminIDs, adminID)
			}
		}
		adminRows.Close()
		adminMessage := fmt.Sprintf(
			"%s disclosed thoughts of self-harm (%s) and has no clinician currently assigned.",
			name, input.Level)
		for _, adminID := range adminIDs {
			if err := s.wellnessNotifyCreate(ctx, adminID, "Risk disclosure awaiting review", adminMessage, "system", false); err != nil {
				s.Log.Error("risk escalation admin notification failed", "err", err, "userId", input.UserID)
			}
		}
	}

	s.audit(ctx, "risk.raised", &input.UserID, ptr("RiskAlert"), alertIDValue, map[string]any{
		"level":        input.Level,
		"sourceType":   input.SourceType,
		"doctorUserId": doctorUserID,
	})

	if clinicianReached && alertID != "" {
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `RiskAlert` SET notifiedDoctorUserId = ? WHERE id = ?", doctorUserID, alertID); err != nil {
			s.Log.Warn("failed to stamp notifiedDoctorUserId", "err", err)
		}
	}

	if !recorded {
		s.Log.Error("risk disclosure escalated with no durable record: the RiskAlert row was not written",
			"userId", input.UserID, "level", input.Level, "clinicianReached", clinicianReached)
	}

	return wellnessRiskSignal(true, input.Level, input.Reason, clinicianReached, recorded, alertIDValue)
}
