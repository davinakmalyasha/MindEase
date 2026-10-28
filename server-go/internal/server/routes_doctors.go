package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-sql-driver/mysql"
	"github.com/microcosm-cc/bluemonday"
)

// registerDoctors ports server/src/routes/doctor.routes.ts with
// doctor.controller.ts, doctor.service.ts, waitlist.service.ts and the
// doctor/appointment/params Zod schemas.
func (s *Server) registerDoctors(api chi.Router) {
	api.With(s.authenticate, s.doctorsRequireDoctor).Get("/doctors/stats", s.doctorsGetStats)
	api.With(s.authenticate, s.doctorsRequireDoctor).Get("/doctors/analytics", s.doctorsGetAnalytics)
	api.With(s.authenticate, s.doctorsRequireDoctor).Get("/doctors/patterns", s.doctorsGetPatterns)
	api.With(s.authenticate).Get("/doctors/packages/my", s.doctorsGetMyPackages)
	api.With(s.authenticate).Post("/doctors/packages/{id}/purchase", s.doctorsPurchasePackage)

	api.Get("/doctors", s.doctorsGetAll)
	api.Get("/doctors/specialties", s.doctorsGetSpecialties)
	api.Get("/doctors/slots/{id}", s.doctorsGetSlots)

	api.With(s.authenticate).Post("/doctors/{id}/waitlist", s.doctorsJoinWaitlist)
	api.With(s.authenticate).Delete("/doctors/{id}/waitlist", s.doctorsLeaveWaitlist)
	api.With(s.authenticate).Get("/doctors/{id}/waitlist/status", s.doctorsWaitlistStatus)

	api.Get("/doctors/{id}/packages", s.doctorsGetPackages)
	api.Get("/doctors/{id}", s.doctorsGetByID)

	api.With(s.authenticate, s.doctorsRequireDoctor).Post("/doctors/packages", s.doctorsCreatePackage)
	api.With(s.authenticate, s.doctorsRequireDoctor).Delete("/doctors/packages/{id}", s.doctorsDeletePackage)

	api.With(s.authenticate, s.doctorsRequireDoctor).Post("/doctors/slots", s.doctorsCreateSlot)
	api.With(s.authenticate, s.doctorsRequireDoctor).Delete("/doctors/slots/{id}", s.doctorsDeleteSlot)

	api.With(s.authenticate, s.doctorsRequireDoctor).Post("/doctors/patterns", s.doctorsCreatePattern)
	api.With(s.authenticate, s.doctorsRequireDoctor).Delete("/doctors/patterns/{id}", s.doctorsDeletePattern)
	api.With(s.authenticate, s.doctorsRequireDoctor).Post("/doctors/patterns/{id}/regenerate", s.doctorsRegeneratePattern)

	api.With(s.authenticate, s.doctorsRequireDoctor).Post("/doctors/away", s.doctorsSetAway)
}

func (s *Server) doctorsRequireDoctor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := CurrentUser(r)
		if user == nil {
			s.Fail(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		if user.Role != "doctor" {
			s.Fail(w, http.StatusForbidden, "Forbidden: doctor access required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) doctorsOK(w http.ResponseWriter, status int, data any) {
	s.JSON(w, status, map[string]any{"status": "success", "data": data})
}

// doctorsFail maps a service error the same way the Node controllers do: a
// typed AppError keeps its status and message; anything else is logged and
// answered with the controller's fixed fallback.
func (s *Server) doctorsFail(w http.ResponseWriter, r *http.Request, err error, status int, message string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("doctors handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, status, message)
}

func (s *Server) doctorsDoctorProfileID(w http.ResponseWriter, r *http.Request) (string, bool) {
	user := CurrentUser(r)
	if user == nil || user.DoctorProfileID == nil || *user.DoctorProfileID == "" {
		s.Fail(w, http.StatusBadRequest, "Doctor profile not found")
		return "", false
	}
	return *user.DoctorProfileID, true
}

// --- validation helpers (Zod schemas) ---------------------------------------

var (
	doctorsUUID7Pattern     = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	doctorsISODayPattern    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	doctorsHHMMPattern      = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	doctorsLocalDatePattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)
	doctorsTimeOfDayPattern = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
)

func (s *Server) doctorsIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if !doctorsUUID7Pattern.MatchString(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return "", false
	}
	return id, true
}

func doctorsJSONTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "unknown"
	}
}

// doctorsFieldTypeName distinguishes an absent key ("undefined") from an
// explicit null, as Zod's invalid_type messages do.
func doctorsFieldTypeName(body map[string]any, key string) string {
	v, present := body[key]
	if !present {
		return "undefined"
	}
	return doctorsJSONTypeName(v)
}

// doctorsJSONBody mirrors `schema.parse({ body: req.body ?? {} })` followed by
// Zod's first-issue reporting for the object itself.
func (s *Server) doctorsJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		s.Fail(w, http.StatusBadRequest, "Invalid request body")
		return nil, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return map[string]any{}, true
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		s.Fail(w, http.StatusBadRequest, "Invalid request body")
		return nil, false
	}
	if parsed == nil {
		return map[string]any{}, true
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		s.validationFail(w, "body", "Invalid input: expected object, received "+doctorsJSONTypeName(parsed))
		return nil, false
	}
	return obj, true
}

// doctorsRealISODay mirrors the refine's `Date.parse(value + "T00:00:00Z")`
// check: V8 accepts days 1-31 for any month 1-12 (overflow rolls over).
func doctorsRealISODay(v string) bool {
	if len(v) != 10 {
		return false
	}
	mo, err1 := strconv.Atoi(v[5:7])
	day, err2 := strconv.Atoi(v[8:10])
	if err1 != nil || err2 != nil {
		return false
	}
	return mo >= 1 && mo <= 12 && day >= 1 && day <= 31
}

func (s *Server) doctorsValidateSlotBody(w http.ResponseWriter, body map[string]any) bool {
	date, ok := body["date"].(string)
	if !ok {
		s.validationFail(w, "body.date", "Invalid input: expected string, received "+doctorsFieldTypeName(body, "date"))
		return false
	}
	if !doctorsISODayPattern.MatchString(date) {
		s.validationFail(w, "body.date", "Date must be YYYY-MM-DD")
		return false
	}
	if !doctorsRealISODay(date) {
		s.validationFail(w, "body.date", "Date is not a real date")
		return false
	}
	for _, f := range []struct{ key, label string }{
		{"start_time", "Start time"},
		{"end_time", "End time"},
	} {
		v, ok := body[f.key].(string)
		if !ok {
			s.validationFail(w, "body."+f.key, "Invalid input: expected string, received "+doctorsFieldTypeName(body, f.key))
			return false
		}
		if !doctorsHHMMPattern.MatchString(v) {
			s.validationFail(w, "body."+f.key, f.label+" must be HH:mm in 24-hour time")
			return false
		}
	}
	return true
}

func (s *Server) doctorsValidatePatternBody(w http.ResponseWriter, body map[string]any) bool {
	wd, ok := body["weekday"].(float64)
	if !ok {
		s.validationFail(w, "body.weekday", "Invalid input: expected number, received "+doctorsFieldTypeName(body, "weekday"))
		return false
	}
	if wd != math.Trunc(wd) {
		s.validationFail(w, "body.weekday", "Invalid input: expected int, received number")
		return false
	}
	if wd < 0 {
		s.validationFail(w, "body.weekday", "Too small: expected number to be >=0")
		return false
	}
	if wd > 6 {
		s.validationFail(w, "body.weekday", "Weekday must be 0 (Monday) to 6 (Sunday)")
		return false
	}
	for _, f := range []struct{ key, label string }{
		{"start_time", "Start time"},
		{"end_time", "End time"},
	} {
		v, ok := body[f.key].(string)
		if !ok {
			s.validationFail(w, "body."+f.key, "Invalid input: expected string, received "+doctorsFieldTypeName(body, f.key))
			return false
		}
		if !doctorsHHMMPattern.MatchString(v) {
			s.validationFail(w, "body."+f.key, f.label+" must be HH:mm in 24-hour time")
			return false
		}
	}
	if raw, present := body["activeFrom"]; present {
		v, ok := raw.(string)
		if !ok {
			s.validationFail(w, "body.activeFrom", "Invalid input: expected string, received "+doctorsJSONTypeName(raw))
			return false
		}
		if !doctorsISODayPattern.MatchString(v) {
			s.validationFail(w, "body.activeFrom", "Active from must be YYYY-MM-DD")
			return false
		}
		if !doctorsRealISODay(v) {
			s.validationFail(w, "body.activeFrom", "Active from is not a real date")
			return false
		}
	}
	if raw, present := body["weeks"]; present {
		v, ok := raw.(float64)
		if !ok {
			s.validationFail(w, "body.weeks", "Invalid input: expected number, received "+doctorsJSONTypeName(raw))
			return false
		}
		if v != math.Trunc(v) {
			s.validationFail(w, "body.weeks", "Invalid input: expected int, received number")
			return false
		}
		if v < 1 {
			s.validationFail(w, "body.weeks", "Too small: expected number to be >=1")
			return false
		}
		if v > 12 {
			s.validationFail(w, "body.weeks", "Too big: expected number to be <=12")
			return false
		}
	}
	return true
}

func (s *Server) doctorsValidateSetAwayBody(w http.ResponseWriter, body map[string]any) bool {
	raw, present := body["awayUntil"]
	if !present {
		s.validationFail(w, "body.awayUntil", "Invalid input: expected string, received undefined")
		return false
	}
	if raw != nil {
		v, ok := raw.(string)
		if !ok {
			s.validationFail(w, "body.awayUntil", "Invalid input: expected string, received "+doctorsJSONTypeName(raw))
			return false
		}
		if !doctorsISODayPattern.MatchString(v) {
			s.validationFail(w, "body.awayUntil", "Use the format YYYY-MM-DD")
			return false
		}
		if !doctorsRealISODay(v) {
			s.validationFail(w, "body.awayUntil", "Not a real calendar date")
			return false
		}
	}
	var unknown []string
	for key := range body {
		if key != "awayUntil" {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		quoted := make([]string, len(unknown))
		for i, k := range unknown {
			quoted[i] = strconv.Quote(k)
		}
		suffix := ""
		if len(unknown) > 1 {
			suffix = "s"
		}
		s.validationFail(w, "body", "Unrecognized key"+suffix+": "+strings.Join(quoted, ", "))
		return false
	}
	return true
}

// --- JS-compatible primitives -----------------------------------------------

// doctorsParseInt mirrors JavaScript's parseInt + `|| default`: leading
// whitespace and a sign are consumed, parsing stops at the first non-digit.
func doctorsParseInt(v string) (int, bool) {
	i := 0
	for i < len(v) && (v[i] == ' ' || v[i] == '\t' || v[i] == '\n' || v[i] == '\r' || v[i] == '\f' || v[i] == '\v') {
		i++
	}
	sign := 1
	if i < len(v) && (v[i] == '+' || v[i] == '-') {
		if v[i] == '-' {
			sign = -1
		}
		i++
	}
	start := i
	for i < len(v) && v[i] >= '0' && v[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(v[start:i])
	if err != nil {
		return 0, false
	}
	return sign * n, true
}

// doctorsParseNumber mirrors the controller's `num()`: empty and non-finite
// values are undefined; whitespace coerces to 0 like Number(" ").
func doctorsParseNumber(v string) (float64, bool) {
	if v == "" {
		return 0, false
	}
	trimmed := strings.TrimSpace(v)
	if trimmed == "" {
		return 0, true
	}
	f, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func doctorsParseLocalDate(v string) (time.Time, bool) {
	m := doctorsLocalDatePattern.FindStringSubmatch(v)
	if m == nil {
		return time.Time{}, false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	return time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.Local), true
}

func doctorsStartOfLocalDay(t time.Time) time.Time {
	lt := t.In(time.Local)
	return time.Date(lt.Year(), lt.Month(), lt.Day(), 0, 0, 0, 0, time.Local)
}

func doctorsEndOfLocalDay(t time.Time) time.Time {
	lt := t.In(time.Local)
	return time.Date(lt.Year(), lt.Month(), lt.Day(), 23, 59, 59, 999000000, time.Local)
}

func doctorsLocalDateKey(t time.Time) string {
	lt := t.In(time.Local)
	return fmt.Sprintf("%04d-%02d-%02d", lt.Year(), int(lt.Month()), lt.Day())
}

func doctorsMonthKey(t time.Time) string {
	lt := t.In(time.Local)
	return fmt.Sprintf("%04d-%02d", lt.Year(), int(lt.Month()))
}

func doctorsTimeToMinutes(v string) (int, bool) {
	m := doctorsTimeOfDayPattern.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	if h > 24 || mi > 59 {
		return 0, false
	}
	return h*60 + mi, true
}

func doctorsNullStr(n sql.NullString) *string {
	if n.Valid {
		v := n.String
		return &v
	}
	return nil
}

// doctorsStripTagsPolicy is the second pass of utils/sanitize.ts: the port's
// shared UGC policy keeps formatting tags, but Node's sanitize() is configured
// with `allowedTags: []`, so every tag is removed and only the text survives.
var doctorsStripTagsPolicy = bluemonday.StripTagsPolicy()

// doctorsSanitizeText is sanitize(): trim, strip markup, cap at 4000 UTF-16
// code units.
func (s *Server) doctorsSanitizeText(input string) string {
	cleaned := s.Sanitizer.Sanitize(strings.TrimSpace(input))
	cleaned = doctorsStripTagsPolicy.Sanitize(cleaned)
	return doctorsSliceUTF16(strings.TrimSpace(cleaned), 4000)
}

func doctorsSliceUTF16(value string, max int) string {
	units := 0
	for i, r := range value {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
		if units > max {
			return value[:i]
		}
	}
	return value
}

func doctorsIsDuplicate(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}

// --- cache ------------------------------------------------------------------

const (
	doctorsSpecialtiesCacheKey = "cache:doctors:specialties:v1"
	doctorsDirectoryCacheKey   = "cache:doctors:directory"
)

func doctorsDirectoryCacheKeyFor(limit int) string {
	return fmt.Sprintf("%s:v2:%d", doctorsDirectoryCacheKey, limit)
}

func doctorsDetailCacheKey(id string) string {
	return "cache:doctors:detail:" + id
}

func (s *Server) doctorsCacheGet(ctx context.Context, key string, dest any) bool {
	if s.Redis == nil {
		return false
	}
	raw, err := s.Redis.Get(ctx, key).Result()
	if err != nil || raw == "" {
		return false
	}
	return json.Unmarshal([]byte(raw), dest) == nil
}

// doctorsCacheGetRaw is used where the cached payload contains JS-shaped dates:
// JSTime does not implement json.Unmarshaler, so the stored JSON is served
// verbatim instead of being round-tripped through the response structs.
func (s *Server) doctorsCacheGetRaw(ctx context.Context, key string) (json.RawMessage, bool) {
	if s.Redis == nil {
		return nil, false
	}
	raw, err := s.Redis.Get(ctx, key).Bytes()
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	return json.RawMessage(raw), true
}

func (s *Server) doctorsCacheSetRaw(ctx context.Context, key string, raw []byte, ttl time.Duration) {
	if s.Redis == nil || len(raw) == 0 {
		return
	}
	_ = s.Redis.Set(ctx, key, raw, ttl).Err()
}

func (s *Server) doctorsRawData(w http.ResponseWriter, status int, raw json.RawMessage) {
	s.JSON(w, status, map[string]any{"status": "success", "data": raw})
}

func (s *Server) doctorsCacheSet(ctx context.Context, key string, v any, ttl time.Duration) {
	if s.Redis == nil {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = s.Redis.Set(ctx, key, raw, ttl).Err()
}

func (s *Server) doctorsCacheDel(ctx context.Context, keys ...string) {
	if s.Redis == nil || len(keys) == 0 {
		return
	}
	_ = s.Redis.Del(ctx, keys...).Err()
}

// doctorsInvalidateDoctorCache clears the doctor's detail entry and both real
// directory page-size keys. The Node hook deletes a `:v2:0` key that is never
// written, leaving page 1 of the directory stale for up to 60s; clearing the
// keys that exist keeps the same short-TTL freshness guarantee without the gap.
func (s *Server) doctorsInvalidateDoctorCache(ctx context.Context, doctorID string) {
	if doctorID == "" {
		s.doctorsCacheDel(ctx, doctorsDirectoryCacheKeyFor(20), doctorsDirectoryCacheKeyFor(50), doctorsSpecialtiesCacheKey)
		return
	}
	s.doctorsCacheDel(ctx, doctorsDirectoryCacheKeyFor(20), doctorsDirectoryCacheKeyFor(50), doctorsDetailCacheKey(doctorID))
}

type doctorsFlightGroup struct {
	mu sync.Mutex
	m  map[string]*doctorsFlightCall
}

type doctorsFlightCall struct {
	wg  sync.WaitGroup
	val any
	err error
}

var doctorsDirectoryFlight = &doctorsFlightGroup{m: map[string]*doctorsFlightCall{}}

func (g *doctorsFlightGroup) Do(key string, fn func() (any, error)) (any, error) {
	g.mu.Lock()
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &doctorsFlightCall{}
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()
	c.wg.Done()
	return c.val, c.err
}

// --- response shapes --------------------------------------------------------

type doctorsDirectoryUser struct {
	Name   *string `json:"name"`
	Avatar *string `json:"avatar"`
}

type doctorsReviewCount struct {
	Reviews int `json:"reviews"`
}

type doctorsDirectoryRow struct {
	ID                 string               `json:"id"`
	Specialty          string               `json:"specialty"`
	Experience         int                  `json:"experience"`
	Price              int                  `json:"price"`
	Rating             float64              `json:"rating"`
	TotalReviews       int                  `json:"totalReviews"`
	VerificationStatus string               `json:"verificationStatus"`
	User               doctorsDirectoryUser `json:"user"`
	Count              doctorsReviewCount   `json:"_count"`
}

type doctorsDirectoryResult struct {
	Rows       []doctorsDirectoryRow `json:"rows"`
	Total      int                   `json:"total"`
	Page       int                   `json:"page"`
	TotalPages int                   `json:"totalPages"`
}

type doctorsDetailUser struct {
	ID     string  `json:"id"`
	Name   *string `json:"name"`
	Avatar *string `json:"avatar"`
}

type doctorsDetailPattern struct {
	Weekday   int    `json:"weekday"`
	StartTime string `json:"startTime"`
	EndTime   string `json:"endTime"`
}

type doctorsDetailReview struct {
	ID          string  `json:"id"`
	Rating      int     `json:"rating"`
	Comment     string  `json:"comment"`
	Reply       *string `json:"reply"`
	RepliedAt   *JSTime `json:"repliedAt"`
	CreatedAt   JSTime  `json:"createdAt"`
	DisplayName string  `json:"displayName"`
}

type doctorsDetailSlot struct {
	ID        string `json:"id"`
	Date      JSTime `json:"date"`
	StartTime string `json:"startTime"`
	EndTime   string `json:"endTime"`
	IsBooked  bool   `json:"isBooked"`
}

type doctorsDetailRow struct {
	ID                   string                 `json:"id"`
	Specialty            string                 `json:"specialty"`
	Bio                  string                 `json:"bio"`
	Experience           int                    `json:"experience"`
	Price                int                    `json:"price"`
	Rating               float64                `json:"rating"`
	TotalReviews         int                    `json:"totalReviews"`
	LicenseNumber        *string                `json:"licenseNumber"`
	LicenseIssuer        *string                `json:"licenseIssuer"`
	Languages            *string                `json:"languages"`
	Education            *string                `json:"education"`
	VerificationStatus   string                 `json:"verificationStatus"`
	Availability         string                 `json:"availability"`
	AvailabilityPatterns []doctorsDetailPattern `json:"availabilityPatterns"`
	User                 doctorsDetailUser      `json:"user"`
	Count                doctorsReviewCount     `json:"_count"`
	Reviews              []doctorsDetailReview  `json:"reviews"`
	ConsultationSlots    []doctorsDetailSlot    `json:"consultationSlots"`
}

type doctorsSlotRow struct {
	ID        string `json:"id"`
	DoctorID  string `json:"doctorId"`
	Date      JSTime `json:"date"`
	StartTime string `json:"startTime"`
	EndTime   string `json:"endTime"`
	IsBooked  bool   `json:"isBooked"`
}

type doctorsPackageRow struct {
	ID           string  `json:"id"`
	DoctorID     string  `json:"doctorId"`
	Name         string  `json:"name"`
	Description  *string `json:"description"`
	SessionCount int     `json:"sessionCount"`
	TotalPrice   int     `json:"totalPrice"`
	Active       bool    `json:"active"`
	CreatedAt    JSTime  `json:"createdAt"`
}

type doctorsPatternFull struct {
	ID          string  `json:"id"`
	DoctorID    string  `json:"doctorId"`
	Weekday     int     `json:"weekday"`
	StartTime   string  `json:"startTime"`
	EndTime     string  `json:"endTime"`
	ActiveFrom  JSTime  `json:"activeFrom"`
	ActiveUntil *JSTime `json:"activeUntil"`
	CreatedAt   JSTime  `json:"createdAt"`
}

type doctorsGeneratedSlot struct {
	Date      string `json:"date"`
	StartTime string `json:"startTime"`
	EndTime   string `json:"endTime"`
}

type doctorsWaitlistRow struct {
	ID         string  `json:"id"`
	DoctorID   string  `json:"doctorId"`
	PatientID  string  `json:"patientId"`
	Status     string  `json:"status"`
	NotifiedAt *JSTime `json:"notifiedAt"`
	CreatedAt  JSTime  `json:"createdAt"`
}

type doctorsMyPurchaseDoctor struct {
	ID   string `json:"id"`
	User struct {
		Name *string `json:"name"`
	} `json:"user"`
}

type doctorsMyPurchasePackage struct {
	ID           string                  `json:"id"`
	Name         string                  `json:"name"`
	Description  *string                 `json:"description"`
	SessionCount int                     `json:"sessionCount"`
	TotalPrice   int                     `json:"totalPrice"`
	Doctor       doctorsMyPurchaseDoctor `json:"doctor"`
}

type doctorsMyPurchase struct {
	ID           string                   `json:"id"`
	PackageID    string                   `json:"packageId"`
	SessionsLeft int                      `json:"sessionsLeft"`
	Status       string                   `json:"status"`
	PaidAt       *JSTime                  `json:"paidAt"`
	CreatedAt    JSTime                   `json:"createdAt"`
	Package      doctorsMyPurchasePackage `json:"package"`
}

type doctorsPurchasePackageDoctor struct {
	VerificationStatus string `json:"verificationStatus"`
	UserID             string `json:"userId"`
}

type doctorsPurchasePackage struct {
	ID           string                       `json:"id"`
	DoctorID     string                       `json:"doctorId"`
	Name         string                       `json:"name"`
	Description  *string                      `json:"description"`
	SessionCount int                          `json:"sessionCount"`
	TotalPrice   int                          `json:"totalPrice"`
	Active       bool                         `json:"active"`
	CreatedAt    JSTime                       `json:"createdAt"`
	Doctor       doctorsPurchasePackageDoctor `json:"doctor"`
}

type doctorsPurchaseResponse struct {
	ID              string                 `json:"id"`
	PackageID       string                 `json:"packageId"`
	UserID          string                 `json:"userId"`
	SessionsLeft    int                    `json:"sessionsLeft"`
	Status          string                 `json:"status"`
	PaidAt          *JSTime                `json:"paidAt"`
	GrantedByUserID *string                `json:"grantedByUserId"`
	TotalPrice      int                    `json:"totalPrice"`
	SessionCount    int                    `json:"sessionCount"`
	Reference       *string                `json:"reference"`
	LiveKey         *string                `json:"liveKey"`
	CreatedAt       JSTime                 `json:"createdAt"`
	Package         doctorsPurchasePackage `json:"package"`
}

type doctorsAnalyticsMonth struct {
	Key       string   `json:"key"`
	Label     string   `json:"label"`
	Revenue   int      `json:"revenue"`
	Bookings  int      `json:"bookings"`
	AvgRating *float64 `json:"avgRating"`
}

// --- directory --------------------------------------------------------------

type doctorsDirectoryFilters struct {
	page          int
	limit         int
	specialty     string
	search        string
	priceMin      *float64
	priceMax      *float64
	minExperience *float64
	availableOnly bool
	orderBy       string
}

func (s *Server) doctorsGetAll(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page := 1
	if v, ok := doctorsParseInt(q.Get("page")); ok && v != 0 {
		page = v
	}
	limit := 20
	if v, ok := doctorsParseInt(q.Get("limit")); ok && v != 0 {
		limit = v
	}
	if limit > 50 {
		limit = 50
	}
	if limit < 1 {
		limit = 20
	}

	specialty := q.Get("specialty")
	search := q.Get("q")
	priceMin, hasPriceMin := doctorsParseNumber(q.Get("priceMin"))
	priceMax, hasPriceMax := doctorsParseNumber(q.Get("priceMax"))
	minExperience, hasMinExperience := doctorsParseNumber(q.Get("minExperience"))
	availableOnly := q.Get("availableOnly") == "true"
	sortKey := ""
	switch q.Get("sort") {
	case "rating", "price_asc", "price_desc", "experience":
		sortKey = q.Get("sort")
	}
	orderBy := "d.rating DESC"
	switch sortKey {
	case "price_asc":
		orderBy = "d.price ASC"
	case "price_desc":
		orderBy = "d.price DESC"
	case "experience":
		orderBy = "d.experience DESC"
	}

	filters := doctorsDirectoryFilters{
		page:          page,
		limit:         limit,
		specialty:     specialty,
		search:        search,
		availableOnly: availableOnly,
		orderBy:       orderBy,
	}
	if hasPriceMin {
		filters.priceMin = &priceMin
	}
	if hasPriceMax {
		filters.priceMax = &priceMax
	}
	if hasMinExperience {
		filters.minExperience = &minExperience
	}

	isUncached := search != "" || specialty != "" || hasPriceMin || hasPriceMax ||
		hasMinExperience || availableOnly || (sortKey != "" && sortKey != "rating")

	ctx := r.Context()
	if page == 1 && !isUncached {
		key := doctorsDirectoryCacheKeyFor(limit)
		if raw, ok := s.doctorsCacheGetRaw(ctx, key); ok {
			s.doctorsRawData(w, http.StatusOK, raw)
			return
		}
		v, err := doctorsDirectoryFlight.Do(key, func() (any, error) {
			res, err := s.doctorsQueryDirectory(ctx, filters)
			if err != nil {
				return nil, err
			}
			raw, err := json.Marshal(res)
			if err != nil {
				return nil, err
			}
			s.doctorsCacheSetRaw(ctx, key, raw, 60*time.Second)
			return json.RawMessage(raw), nil
		})
		if err != nil {
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		s.doctorsRawData(w, http.StatusOK, v.(json.RawMessage))
		return
	}

	res, err := s.doctorsQueryDirectory(ctx, filters)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	s.doctorsOK(w, http.StatusOK, res)
}

func (s *Server) doctorsQueryDirectory(ctx context.Context, f doctorsDirectoryFilters) (*doctorsDirectoryResult, error) {
	where := []string{"d.verificationStatus = 'approved'", "(d.awayUntil IS NULL OR d.awayUntil <= ?)"}
	args := []any{time.Now().UTC()}
	if f.specialty != "" {
		where = append(where, "d.specialty = ?")
		args = append(args, f.specialty)
	}
	if f.priceMin != nil {
		where = append(where, "d.price >= ?")
		args = append(args, *f.priceMin)
	}
	if f.priceMax != nil {
		where = append(where, "d.price <= ?")
		args = append(args, *f.priceMax)
	}
	if f.minExperience != nil {
		where = append(where, "d.experience >= ?")
		args = append(args, *f.minExperience)
	}
	if f.availableOnly {
		where = append(where, "d.availability = 'Available'")
	}
	if f.search != "" {
		like := "%" + strings.TrimSpace(f.search) + "%"
		where = append(where, "(d.specialty LIKE ? OR d.bio LIKE ? OR u.name LIKE ?)")
		args = append(args, like, like, like)
	}
	whereSQL := strings.Join(where, " AND ")

	var total int
	if err := s.DB.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `Doctor` d JOIN `User` u ON u.id = d.userId WHERE "+whereSQL, args...).Scan(&total); err != nil {
		return nil, err
	}

	take := f.limit
	skip := (f.page - 1) * f.limit
	query := "SELECT d.id, d.specialty, d.experience, d.price, d.rating, d.totalReviews, d.verificationStatus, u.name, u.avatar, " +
		"(SELECT COUNT(*) FROM `Review` r WHERE r.doctorId = d.id AND r.hidden = FALSE) AS reviewCount " +
		"FROM `Doctor` d JOIN `User` u ON u.id = d.userId WHERE " + whereSQL +
		" ORDER BY " + f.orderBy + " LIMIT ? OFFSET ?"
	rows, err := s.DB.QueryContext(ctx, query, append(append([]any{}, args...), take, skip)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &doctorsDirectoryResult{Rows: []doctorsDirectoryRow{}, Total: total, Page: f.page, TotalPages: (total + take - 1) / take}
	for rows.Next() {
		var (
			row         doctorsDirectoryRow
			name        sql.NullString
			avatar      sql.NullString
			reviewCount int
		)
		if err := rows.Scan(&row.ID, &row.Specialty, &row.Experience, &row.Price, &row.Rating,
			&row.TotalReviews, &row.VerificationStatus, &name, &avatar, &reviewCount); err != nil {
			return nil, err
		}
		row.User.Name = doctorsNullStr(name)
		row.User.Avatar = doctorsNullStr(avatar)
		row.Count.Reviews = reviewCount
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) doctorsGetSpecialties(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var cached []string
	if s.doctorsCacheGet(ctx, doctorsSpecialtiesCacheKey, &cached) {
		s.doctorsOK(w, http.StatusOK, cached)
		return
	}
	rows, err := s.DB.QueryContext(ctx,
		"SELECT DISTINCT d.specialty FROM `Doctor` d WHERE d.verificationStatus = 'approved' AND (d.awayUntil IS NULL OR d.awayUntil <= ?) ORDER BY d.specialty ASC",
		time.Now().UTC())
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var specialty string
		if err := rows.Scan(&specialty); err != nil {
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		if specialty != "" {
			out = append(out, specialty)
		}
	}
	if err := rows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	s.doctorsCacheSet(ctx, doctorsSpecialtiesCacheKey, out, 300*time.Second)
	s.doctorsOK(w, http.StatusOK, out)
}

// --- doctor detail ----------------------------------------------------------

func (s *Server) doctorsGetByID(w http.ResponseWriter, r *http.Request) {
	id, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	cacheKey := doctorsDetailCacheKey(id)
	if raw, ok := s.doctorsCacheGetRaw(ctx, cacheKey); ok {
		s.doctorsRawData(w, http.StatusOK, raw)
		return
	}

	var detail doctorsDetailRow
	var awayUntil sql.NullTime
	err := s.DB.QueryRowContext(ctx, "SELECT `awayUntil` FROM `Doctor` WHERE id = ?", id).Scan(&awayUntil)
	if err != nil && err != sql.ErrNoRows {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	var (
		licenseNumber sql.NullString
		licenseIssuer sql.NullString
		languages     sql.NullString
		education     sql.NullString
		name          sql.NullString
		avatar        sql.NullString
		reviewCount   int
	)
	err = s.DB.QueryRowContext(ctx,
		"SELECT d.id, d.specialty, d.bio, d.experience, d.price, d.rating, d.totalReviews, "+
			"d.licenseNumber, d.licenseIssuer, d.languages, d.education, d.verificationStatus, d.availability, "+
			"u.id, u.name, u.avatar, "+
			"(SELECT COUNT(*) FROM `Review` r WHERE r.doctorId = d.id AND r.hidden = FALSE) "+
			"FROM `Doctor` d JOIN `User` u ON u.id = d.userId "+
			"WHERE d.id = ? AND d.verificationStatus = 'approved'", id).
		Scan(&detail.ID, &detail.Specialty, &detail.Bio, &detail.Experience, &detail.Price, &detail.Rating,
			&detail.TotalReviews, &licenseNumber, &licenseIssuer, &languages, &education,
			&detail.VerificationStatus, &detail.Availability, &detail.User.ID, &name, &avatar, &reviewCount)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Doctor not found")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	detail.LicenseNumber = doctorsNullStr(licenseNumber)
	detail.LicenseIssuer = doctorsNullStr(licenseIssuer)
	detail.Languages = doctorsNullStr(languages)
	detail.Education = doctorsNullStr(education)
	detail.User.Name = doctorsNullStr(name)
	detail.User.Avatar = doctorsNullStr(avatar)
	detail.Count.Reviews = reviewCount

	detail.AvailabilityPatterns = []doctorsDetailPattern{}
	patternRows, err := s.DB.QueryContext(ctx,
		"SELECT weekday, startTime, endTime FROM `AvailabilityPattern` WHERE doctorId = ? AND activeUntil IS NULL ORDER BY weekday ASC, startTime ASC", id)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	for patternRows.Next() {
		var p doctorsDetailPattern
		if err := patternRows.Scan(&p.Weekday, &p.StartTime, &p.EndTime); err != nil {
			patternRows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		detail.AvailabilityPatterns = append(detail.AvailabilityPatterns, p)
	}
	patternRows.Close()
	if err := patternRows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	detail.Reviews = []doctorsDetailReview{}
	// Public projection: the reviewer's identity is never selected, only a
	// stable pseudonym derived from the user id (same as /reviews/doctor).
	reviewRows, err := s.DB.QueryContext(ctx,
		"SELECT r.id, r.rating, r.comment, r.reply, r.repliedAt, r.createdAt, r.userId "+
			"FROM `Review` r "+
			"WHERE r.doctorId = ? AND r.hidden = FALSE ORDER BY r.createdAt DESC, r.id DESC LIMIT 50", id)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	for reviewRows.Next() {
		var (
			rev       doctorsDetailReview
			reply     sql.NullString
			repliedAt sql.NullTime
			userID    string
		)
		if err := reviewRows.Scan(&rev.ID, &rev.Rating, &rev.Comment, &reply, &repliedAt, &rev.CreatedAt,
			&userID); err != nil {
			reviewRows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		rev.Reply = doctorsNullStr(reply)
		if repliedAt.Valid {
			v := JSTime(repliedAt.Time)
			rev.RepliedAt = &v
		}
		rev.DisplayName = reviewDisplayName(userID)
		detail.Reviews = append(detail.Reviews, rev)
	}
	reviewRows.Close()
	if err := reviewRows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	detail.ConsultationSlots = []doctorsDetailSlot{}
	today := doctorsStartOfLocalDay(time.Now())
	slotWhere := "doctorId = ? AND isBooked = FALSE AND date >= ?"
	slotArgs := []any{id, today}
	if bound := doctorsAwayBound(awayUntil, today); bound != nil {
		slotWhere += " AND date > ?"
		slotArgs = append(slotArgs, *bound)
	}
	slotRows, err := s.DB.QueryContext(ctx,
		"SELECT id, date, startTime, endTime, isBooked FROM `ConsultationSlot` WHERE "+slotWhere+
			" ORDER BY date ASC, startTime ASC LIMIT 60", slotArgs...)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	for slotRows.Next() {
		var slot doctorsDetailSlot
		if err := slotRows.Scan(&slot.ID, &slot.Date, &slot.StartTime, &slot.EndTime, &slot.IsBooked); err != nil {
			slotRows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		detail.ConsultationSlots = append(detail.ConsultationSlots, slot)
	}
	slotRows.Close()
	if err := slotRows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	if data, err := json.Marshal(&detail); err == nil {
		s.doctorsCacheSetRaw(ctx, cacheKey, data, 120*time.Second)
	}
	s.doctorsOK(w, http.StatusOK, &detail)
}

// doctorsAwayBound mirrors applyAwayWindow: a live away window hides slots up
// to and including the away day, and an elapsed one is ignored.
func doctorsAwayBound(awayUntil sql.NullTime, today time.Time) *time.Time {
	if !awayUntil.Valid {
		return nil
	}
	awayEnd := doctorsEndOfLocalDay(awayUntil.Time)
	if !awayEnd.Before(today) {
		return &awayEnd
	}
	return nil
}

// --- slots ------------------------------------------------------------------

func (s *Server) doctorsGetSlots(w http.ResponseWriter, r *http.Request) {
	id, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var awayUntil sql.NullTime
	err := s.DB.QueryRowContext(ctx, "SELECT `awayUntil` FROM `Doctor` WHERE id = ?", id).Scan(&awayUntil)
	if err != nil && err != sql.ErrNoRows {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	today := doctorsStartOfLocalDay(time.Now())
	where := "doctorId = ? AND date >= ?"
	args := []any{id, today}
	if bound := doctorsAwayBound(awayUntil, today); bound != nil {
		where += " AND date > ?"
		args = append(args, *bound)
	}
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, doctorId, date, startTime, endTime, isBooked FROM `ConsultationSlot` WHERE "+where+
			" ORDER BY date ASC, startTime ASC LIMIT 400", args...)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	defer rows.Close()
	slots := []doctorsSlotRow{}
	for rows.Next() {
		var slot doctorsSlotRow
		if err := rows.Scan(&slot.ID, &slot.DoctorID, &slot.Date, &slot.StartTime, &slot.EndTime, &slot.IsBooked); err != nil {
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		slots = append(slots, slot)
	}
	if err := rows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	s.doctorsOK(w, http.StatusOK, slots)
}

func (s *Server) doctorsCreateSlot(w http.ResponseWriter, r *http.Request) {
	body, ok := s.doctorsJSONBody(w, r)
	if !ok {
		return
	}
	if !s.doctorsValidateSlotBody(w, body) {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	slotDate, _ := doctorsParseLocalDate(body["date"].(string))
	today := doctorsStartOfLocalDay(time.Now())
	if slotDate.Before(today) {
		s.Fail(w, http.StatusBadRequest, "Cannot create slots in the past")
		return
	}
	startTime := body["start_time"].(string)
	endTime := body["end_time"].(string)
	start, startOK := doctorsTimeToMinutes(startTime)
	end, endOK := doctorsTimeToMinutes(endTime)
	if !startOK || !endOK {
		s.Fail(w, http.StatusBadRequest, "Invalid time format (HH:MM)")
		return
	}
	if start >= end {
		s.Fail(w, http.StatusBadRequest, "End time must be after start time")
		return
	}

	dayStart := doctorsStartOfLocalDay(slotDate)
	dayEnd := dayStart.AddDate(0, 0, 1)
	existing, err := s.DB.QueryContext(ctx,
		"SELECT startTime, endTime FROM `ConsultationSlot` WHERE doctorId = ? AND date >= ? AND date < ?",
		doctorID, dayStart, dayEnd)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create slot.")
		return
	}
	conflict := false
	for existing.Next() {
		var es, ee string
		if err := existing.Scan(&es, &ee); err != nil {
			existing.Close()
			s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create slot.")
			return
		}
		esM, esOK := doctorsTimeToMinutes(es)
		eeM, eeOK := doctorsTimeToMinutes(ee)
		if esOK && eeOK && start < eeM && esM < end {
			conflict = true
		}
	}
	existing.Close()
	if err := existing.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create slot.")
		return
	}
	if conflict {
		s.Fail(w, http.StatusBadRequest, "Slot overlaps with an existing slot")
		return
	}

	slot := doctorsSlotRow{
		ID:        newID(),
		DoctorID:  doctorID,
		Date:      jsTimeValue(slotDate),
		StartTime: startTime,
		EndTime:   endTime,
		IsBooked:  false,
	}
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `ConsultationSlot` (id, doctorId, date, startTime, endTime, isBooked) VALUES (?,?,?,?,?,?)",
		slot.ID, doctorID, slotDate, startTime, endTime, false)
	if err != nil {
		if doctorsIsDuplicate(err) {
			s.Fail(w, http.StatusConflict, "This exact slot already exists")
			return
		}
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create slot.")
		return
	}
	s.doctorsInvalidateDoctorCache(ctx, doctorID)
	s.doctorsOK(w, http.StatusCreated, &slot)
}

func (s *Server) doctorsDeleteSlot(w http.ResponseWriter, r *http.Request) {
	slotID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var slot doctorsSlotRow
	err := s.DB.QueryRowContext(ctx,
		"SELECT id, doctorId, date, startTime, endTime, isBooked FROM `ConsultationSlot` WHERE id = ? AND doctorId = ?",
		slotID, doctorID).
		Scan(&slot.ID, &slot.DoctorID, &slot.Date, &slot.StartTime, &slot.EndTime, &slot.IsBooked)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Slot not found.")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to delete slot.")
		return
	}
	if slot.IsBooked {
		s.Fail(w, http.StatusBadRequest, "Cannot delete a booked slot.")
		return
	}
	if _, err := s.DB.ExecContext(ctx, "DELETE FROM `ConsultationSlot` WHERE id = ?", slotID); err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to delete slot.")
		return
	}
	s.doctorsInvalidateDoctorCache(ctx, doctorID)
	s.doctorsOK(w, http.StatusOK, &slot)
}

// --- waitlist ---------------------------------------------------------------

func (s *Server) doctorsJoinWaitlist(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	user := CurrentUser(r)
	ctx := r.Context()
	var exists string
	err := s.DB.QueryRowContext(ctx, "SELECT id FROM `Doctor` WHERE id = ?", doctorID).Scan(&exists)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Doctor not found")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to join waitlist.")
		return
	}

	var status string
	err = s.DB.QueryRowContext(ctx,
		"SELECT status FROM `WaitlistEntry` WHERE doctorId = ? AND patientId = ?", doctorID, user.ID).Scan(&status)
	if err == nil && status != "expired" && status != "booked" {
		s.Fail(w, http.StatusConflict, "You are already on this waitlist")
		return
	}
	if err != nil && err != sql.ErrNoRows {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to join waitlist.")
		return
	}

	now := time.Now().UTC()
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `WaitlistEntry` (id, doctorId, patientId, status, notifiedAt, createdAt) VALUES (?,?,?,?,NULL,?) "+
			"ON DUPLICATE KEY UPDATE status = 'waiting', notifiedAt = NULL",
		newID(), doctorID, user.ID, "waiting", now)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to join waitlist.")
		return
	}

	entry, err := s.doctorsWaitlistEntry(ctx, doctorID, user.ID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to join waitlist.")
		return
	}
	s.doctorsOK(w, http.StatusCreated, entry)
}

func (s *Server) doctorsWaitlistEntry(ctx context.Context, doctorID, patientID string) (*doctorsWaitlistRow, error) {
	var entry doctorsWaitlistRow
	var notifiedAt sql.NullTime
	err := s.DB.QueryRowContext(ctx,
		"SELECT id, doctorId, patientId, status, notifiedAt, createdAt FROM `WaitlistEntry` WHERE doctorId = ? AND patientId = ?",
		doctorID, patientID).
		Scan(&entry.ID, &entry.DoctorID, &entry.PatientID, &entry.Status, &notifiedAt, &entry.CreatedAt)
	if err != nil {
		return nil, err
	}
	if notifiedAt.Valid {
		v := JSTime(notifiedAt.Time)
		entry.NotifiedAt = &v
	}
	return &entry, nil
}

func (s *Server) doctorsLeaveWaitlist(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	user := CurrentUser(r)
	_, err := s.DB.ExecContext(r.Context(),
		"UPDATE `WaitlistEntry` SET status = 'expired' WHERE doctorId = ? AND patientId = ? AND status IN ('waiting','notified')",
		doctorID, user.ID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to leave waitlist.")
		return
	}
	s.doctorsOK(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) doctorsWaitlistStatus(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	user := CurrentUser(r)
	var entry doctorsWaitlistRow
	var notifiedAt sql.NullTime
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT id, doctorId, patientId, status, notifiedAt, createdAt FROM `WaitlistEntry` "+
			"WHERE doctorId = ? AND patientId = ? AND status IN ('waiting','notified')",
		doctorID, user.ID).
		Scan(&entry.ID, &entry.DoctorID, &entry.PatientID, &entry.Status, &notifiedAt, &entry.CreatedAt)
	if err == sql.ErrNoRows {
		s.doctorsOK(w, http.StatusOK, map[string]any{"onWaitlist": false})
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch waitlist status.")
		return
	}
	s.doctorsOK(w, http.StatusOK, map[string]any{
		"onWaitlist": true,
		"status":     entry.Status,
		"joinedAt":   entry.CreatedAt,
	})
}

// doctorsNotifyWaiters ports WaitlistService.notifyWaiters: claim up to three
// waiting entries and create the in-app notification each preference allows.
// Email/realtime/web-push fan-out is not part of this port.
func (s *Server) doctorsNotifyWaiters(ctx context.Context, doctorID string) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, patientId FROM `WaitlistEntry` WHERE doctorId = ? AND status = 'waiting' ORDER BY createdAt ASC LIMIT 3",
		doctorID)
	if err != nil {
		return
	}
	type waiter struct{ id, patientID string }
	waiters := []waiter{}
	for rows.Next() {
		var w waiter
		if err := rows.Scan(&w.id, &w.patientID); err != nil {
			rows.Close()
			return
		}
		waiters = append(waiters, w)
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}

	for _, w := range waiters {
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `WaitlistEntry` SET status = 'notified', notifiedAt = ? WHERE id = ? AND status = 'waiting'",
			time.Now().UTC(), w.id)
		if err != nil {
			continue
		}
		claimed, _ := res.RowsAffected()
		if claimed != 1 {
			continue
		}
		s.doctorsCreateNotification(ctx, w.patientID,
			"A slot just opened",
			"One of your waitlisted psychologists just opened a new slot. Book it before it's gone!")
	}
}

func (s *Server) doctorsCreateNotification(ctx context.Context, userID, title, message string) {
	var prefsRaw sql.NullString
	if err := s.DB.QueryRowContext(ctx, "SELECT `notificationPrefs` FROM `User` WHERE id = ?", userID).Scan(&prefsRaw); err != nil {
		return
	}
	inApp := true
	if prefsRaw.Valid {
		var parsed map[string]any
		if json.Unmarshal([]byte(prefsRaw.String), &parsed) == nil {
			if v, ok := parsed["appointment"]; ok {
				switch t := v.(type) {
				case bool:
					inApp = t
				case map[string]any:
					inApp = t["inApp"] != false
				}
			}
		}
	}
	if !inApp {
		return
	}
	title = s.doctorsSanitizeText(title)
	message = s.doctorsSanitizeText(message)
	_, _ = s.DB.ExecContext(ctx,
		"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), userID, title, message, false, "appointment", time.Now().UTC())
}

// --- patterns ---------------------------------------------------------------

func (s *Server) doctorsGetPatterns(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, doctorId, weekday, startTime, endTime, activeFrom, activeUntil, createdAt FROM `AvailabilityPattern` "+
			"WHERE doctorId = ? ORDER BY weekday ASC, startTime ASC", doctorID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch patterns.")
		return
	}
	defer rows.Close()
	patterns := []doctorsPatternFull{}
	for rows.Next() {
		var (
			p           doctorsPatternFull
			activeUntil sql.NullTime
		)
		if err := rows.Scan(&p.ID, &p.DoctorID, &p.Weekday, &p.StartTime, &p.EndTime, &p.ActiveFrom, &activeUntil, &p.CreatedAt); err != nil {
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch patterns.")
			return
		}
		if activeUntil.Valid {
			v := JSTime(activeUntil.Time)
			p.ActiveUntil = &v
		}
		patterns = append(patterns, p)
	}
	if err := rows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch patterns.")
		return
	}
	s.doctorsOK(w, http.StatusOK, patterns)
}

func (s *Server) doctorsCreatePattern(w http.ResponseWriter, r *http.Request) {
	body, ok := s.doctorsJSONBody(w, r)
	if !ok {
		return
	}
	if !s.doctorsValidatePatternBody(w, body) {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	weekday := int(body["weekday"].(float64))
	startTime := body["start_time"].(string)
	endTime := body["end_time"].(string)
	weeks := 8
	if raw, present := body["weeks"]; present {
		weeks = int(raw.(float64))
	}
	activeFrom := time.Now()
	if raw, present := body["activeFrom"]; present {
		activeFrom, _ = doctorsParseLocalDate(raw.(string))
	}

	start, startOK := doctorsTimeToMinutes(startTime)
	end, endOK := doctorsTimeToMinutes(endTime)
	if !startOK || !endOK || start >= end {
		s.Fail(w, http.StatusBadRequest, "Invalid time format (HH:MM)")
		return
	}

	existing, err := s.DB.QueryContext(ctx,
		"SELECT startTime, endTime FROM `AvailabilityPattern` WHERE doctorId = ? AND weekday = ?", doctorID, weekday)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create pattern.")
		return
	}
	clash := false
	for existing.Next() {
		var otherStart, otherEnd string
		if err := existing.Scan(&otherStart, &otherEnd); err != nil {
			existing.Close()
			s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create pattern.")
			return
		}
		osM, osOK := doctorsTimeToMinutes(otherStart)
		oeM, oeOK := doctorsTimeToMinutes(otherEnd)
		if osOK && oeOK && start < oeM && osM < end {
			clash = true
		}
	}
	existing.Close()
	if err := existing.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create pattern.")
		return
	}
	if clash {
		s.Fail(w, http.StatusBadRequest, "Pattern overlaps with an existing pattern")
		return
	}

	patternID := newID()
	now := time.Now().UTC()
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `AvailabilityPattern` (id, doctorId, weekday, startTime, endTime, activeFrom, activeUntil, createdAt) "+
			"VALUES (?,?,?,?,?,?,NULL,?)",
		patternID, doctorID, weekday, startTime, endTime, activeFrom, now)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create pattern.")
		return
	}
	pattern := doctorsPatternFull{
		ID:         patternID,
		DoctorID:   doctorID,
		Weekday:    weekday,
		StartTime:  startTime,
		EndTime:    endTime,
		ActiveFrom: jsTimeValue(activeFrom),
		CreatedAt:  jsTimeValue(now),
	}

	today := doctorsStartOfLocalDay(time.Now())
	first := doctorsStartOfLocalDay(activeFrom)
	dow := (int(first.Weekday()) + 6) % 7
	offset := ((weekday-dow)%7 + 7) % 7
	if offset == 0 && first.Before(today) {
		offset = 7
	}
	if offset == 0 && first.Before(activeFrom) {
		offset = 7
	}
	first = first.AddDate(0, 0, offset)
	if first.Before(today) {
		first = first.AddDate(0, 0, 7)
	}

	created := []doctorsGeneratedSlot{}
	for week := 0; week < weeks; week++ {
		date := first.AddDate(0, 0, 7*week)
		if date.Before(today) {
			continue
		}
		dayStart := doctorsStartOfLocalDay(date)
		exists, err := s.doctorsSlotExists(ctx, doctorID, dayStart, startTime, endTime)
		if err != nil {
			s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create pattern.")
			return
		}
		if exists {
			continue
		}
		if !s.doctorsInsertGeneratedSlot(ctx, doctorID, dayStart, startTime, endTime) {
			s.Fail(w, http.StatusBadRequest, "Failed to create pattern.")
			return
		}
		created = append(created, doctorsGeneratedSlot{Date: doctorsLocalDateKey(dayStart), StartTime: startTime, EndTime: endTime})
	}

	if len(created) > 0 {
		s.doctorsNotifyWaiters(ctx, doctorID)
	}
	s.doctorsInvalidateDoctorCache(ctx, doctorID)
	s.doctorsOK(w, http.StatusCreated, map[string]any{
		"pattern":        &pattern,
		"generatedSlots": created,
	})
}

func (s *Server) doctorsSlotExists(ctx context.Context, doctorID string, dayStart time.Time, startTime, endTime string) (bool, error) {
	var id string
	err := s.DB.QueryRowContext(ctx,
		"SELECT id FROM `ConsultationSlot` WHERE doctorId = ? AND date >= ? AND date < ? AND startTime = ? AND endTime = ? LIMIT 1",
		doctorID, dayStart, dayStart.AddDate(0, 0, 1), startTime, endTime).Scan(&id)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Server) doctorsInsertGeneratedSlot(ctx context.Context, doctorID string, dayStart time.Time, startTime, endTime string) bool {
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `ConsultationSlot` (id, doctorId, date, startTime, endTime, isBooked) VALUES (?,?,?,?,?,?)",
		newID(), doctorID, dayStart, startTime, endTime, false)
	return err == nil
}

func (s *Server) doctorsDeletePattern(w http.ResponseWriter, r *http.Request) {
	patternID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var id string
	err := s.DB.QueryRowContext(ctx,
		"SELECT id FROM `AvailabilityPattern` WHERE id = ? AND doctorId = ?", patternID, doctorID).Scan(&id)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Pattern not found")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to delete pattern.")
		return
	}
	if _, err := s.DB.ExecContext(ctx, "DELETE FROM `AvailabilityPattern` WHERE id = ?", patternID); err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to delete pattern.")
		return
	}
	s.doctorsInvalidateDoctorCache(ctx, doctorID)
	s.doctorsOK(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) doctorsRegeneratePattern(w http.ResponseWriter, r *http.Request) {
	patternID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var (
		weekday   int
		startTime string
		endTime   string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT weekday, startTime, endTime FROM `AvailabilityPattern` WHERE id = ? AND doctorId = ?",
		patternID, doctorID).Scan(&weekday, &startTime, &endTime)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Pattern not found")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to regenerate pattern.")
		return
	}

	today := doctorsStartOfLocalDay(time.Now())
	horizon := today.AddDate(0, 0, 56)
	offset := ((weekday-((int(today.Weekday())+6)%7))%7 + 7) % 7
	cursor := today.AddDate(0, 0, offset)
	if cursor.Before(today) {
		cursor = cursor.AddDate(0, 0, 7)
	}

	created := []doctorsGeneratedSlot{}
	for d := cursor; !d.After(horizon); d = d.AddDate(0, 0, 7) {
		dayStart := doctorsStartOfLocalDay(d)
		exists, err := s.doctorsSlotExists(ctx, doctorID, dayStart, startTime, endTime)
		if err != nil {
			s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to regenerate pattern.")
			return
		}
		if exists {
			continue
		}
		if !s.doctorsInsertGeneratedSlot(ctx, doctorID, dayStart, startTime, endTime) {
			s.Fail(w, http.StatusBadRequest, "Failed to regenerate pattern.")
			return
		}
		created = append(created, doctorsGeneratedSlot{Date: doctorsLocalDateKey(dayStart), StartTime: startTime, EndTime: endTime})
	}

	s.doctorsInvalidateDoctorCache(ctx, doctorID)
	s.doctorsOK(w, http.StatusOK, map[string]any{"generatedSlots": created})
}

// --- away -------------------------------------------------------------------

func (s *Server) doctorsSetAway(w http.ResponseWriter, r *http.Request) {
	body, ok := s.doctorsJSONBody(w, r)
	if !ok {
		return
	}
	if !s.doctorsValidateSetAwayBody(w, body) {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	var until *time.Time
	if body["awayUntil"] != nil {
		t, _ := doctorsParseLocalDate(body["awayUntil"].(string))
		if t.Before(doctorsStartOfLocalDay(time.Now())) {
			s.Fail(w, http.StatusBadRequest, "Away date must be in the future")
			return
		}
		until = &t
	}
	ctx := r.Context()
	now := time.Now().UTC()
	var err error
	if until != nil {
		_, err = s.DB.ExecContext(ctx, "UPDATE `Doctor` SET awayUntil = ?, updatedAt = ? WHERE id = ?", *until, now, doctorID)
	} else {
		_, err = s.DB.ExecContext(ctx, "UPDATE `Doctor` SET awayUntil = NULL, updatedAt = ? WHERE id = ?", now, doctorID)
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to update away mode.")
		return
	}
	s.doctorsInvalidateDoctorCache(ctx, doctorID)
	s.doctorsOK(w, http.StatusOK, map[string]any{"awayUntil": jsTime(until)})
}

// --- stats and analytics ----------------------------------------------------

func (s *Server) doctorsGetStats(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	counts := map[string]int{}
	total := 0
	rows, err := s.DB.QueryContext(ctx, "SELECT status, COUNT(*) FROM `Appointment` WHERE doctorId = ? GROUP BY status", doctorID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		counts[status] += count
		total += count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	var uniquePatients int
	if err := s.DB.QueryRowContext(ctx,
		"SELECT COUNT(DISTINCT userId) FROM `Appointment` WHERE doctorId = ?", doctorID).Scan(&uniquePatients); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	var upcoming int
	if err := s.DB.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `Appointment` WHERE doctorId = ? AND status = 'confirmed' AND appointmentDate >= ?",
		doctorID, time.Now().UTC()).Scan(&upcoming); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	s.doctorsOK(w, http.StatusOK, map[string]any{
		"totalPatients":         uniquePatients,
		"pendingAppointments":   counts["pending"],
		"confirmedAppointments": counts["confirmed"],
		"completedAppointments": counts["completed"],
		"upcomingAppointments":  upcoming,
		"totalAppointments":     total,
	})
}

func (s *Server) doctorsGetAnalytics(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	now := time.Now().In(time.Local)
	year, month := now.Year(), int(now.Month())

	statusBreakdown := map[string]int{}
	statusRows, err := s.DB.QueryContext(ctx,
		"SELECT status, COUNT(status) FROM `Appointment` WHERE doctorId = ? GROUP BY status", doctorID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	total := 0
	for statusRows.Next() {
		var status string
		var count int
		if err := statusRows.Scan(&status, &count); err != nil {
			statusRows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		statusBreakdown[status] += count
		total += count
	}
	statusRows.Close()
	if err := statusRows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	cancellationRate := 0.0
	if total > 0 {
		cancellationRate = math.Round(float64(statusBreakdown["cancelled"])/float64(total)*1000) / 10
	}

	months := make([]doctorsAnalyticsMonth, 0, 6)
	for i := 5; i >= 0; i-- {
		start := time.Date(year, time.Month(month-i), 1, 0, 0, 0, 0, time.Local)
		months = append(months, doctorsAnalyticsMonth{
			Key:   fmt.Sprintf("%04d-%02d", start.Year(), int(start.Month())),
			Label: start.Format("Jan"),
		})
	}

	// `new Date(months[0].key + "-01")` parses as UTC midnight in JS.
	completedThreshold, _ := time.Parse("2006-01-02", months[0].Key+"-01")
	completedRows, err := s.DB.QueryContext(ctx,
		"SELECT a.appointmentDate, d.price FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId "+
			"WHERE a.doctorId = ? AND a.status = 'completed' AND a.appointmentDate >= ?",
		doctorID, completedThreshold)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	for completedRows.Next() {
		var (
			appointmentDate time.Time
			price           int
		)
		if err := completedRows.Scan(&appointmentDate, &price); err != nil {
			completedRows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		key := doctorsMonthKey(appointmentDate)
		for i := range months {
			if months[i].Key == key {
				months[i].Bookings++
				months[i].Revenue += price
				break
			}
		}
	}
	completedRows.Close()
	if err := completedRows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}

	reviewThreshold := time.Date(year, time.Month(month-5), 1, 0, 0, 0, 0, time.Local)
	ratingRows, err := s.DB.QueryContext(ctx,
		"SELECT rating, createdAt FROM `Review` WHERE doctorId = ? AND createdAt >= ?", doctorID, reviewThreshold)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	type ratingAgg struct{ sum, count int }
	ratings := map[string]*ratingAgg{}
	for ratingRows.Next() {
		var (
			rating    int
			createdAt time.Time
		)
		if err := ratingRows.Scan(&rating, &createdAt); err != nil {
			ratingRows.Close()
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
			return
		}
		key := doctorsMonthKey(createdAt)
		agg := ratings[key]
		if agg == nil {
			agg = &ratingAgg{}
			ratings[key] = agg
		}
		agg.sum += rating
		agg.count++
	}
	ratingRows.Close()
	if err := ratingRows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	for i := range months {
		if agg := ratings[months[i].Key]; agg != nil && agg.count > 0 {
			v := math.Round(float64(agg.sum)/float64(agg.count)*10) / 10
			months[i].AvgRating = &v
		}
	}

	var (
		moodAvg     sql.NullFloat64
		moodEntries int
	)
	err = s.DB.QueryRowContext(ctx,
		"SELECT AVG(m.mood), COUNT(m.mood) FROM `MoodEntry` m "+
			"WHERE m.createdAt >= ? AND EXISTS (SELECT 1 FROM `Appointment` a "+
			"WHERE a.userId = m.userId AND a.doctorId = ? AND a.status = 'completed')",
		time.Now().Add(-30*24*time.Hour), doctorID).Scan(&moodAvg, &moodEntries)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	var moodAverage any
	if moodAvg.Valid && moodAvg.Float64 != 0 {
		moodAverage = math.Round(moodAvg.Float64*10) / 10
	}

	s.doctorsOK(w, http.StatusOK, map[string]any{
		"statusBreakdown":   statusBreakdown,
		"totalAppointments": total,
		"cancellationRate":  cancellationRate,
		"monthly":           months,
		"patientMood": map[string]any{
			"average": moodAverage,
			"entries": moodEntries,
		},
	})
}

// --- packages ---------------------------------------------------------------

func (s *Server) doctorsGetPackages(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, doctorId, name, description, sessionCount, totalPrice, active, createdAt FROM `Package` "+
			"WHERE doctorId = ? AND active = TRUE ORDER BY createdAt DESC", doctorID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
		return
	}
	defer rows.Close()
	packages := []doctorsPackageRow{}
	for rows.Next() {
		var (
			pkg         doctorsPackageRow
			description sql.NullString
		)
		if err := rows.Scan(&pkg.ID, &pkg.DoctorID, &pkg.Name, &description, &pkg.SessionCount, &pkg.TotalPrice, &pkg.Active, &pkg.CreatedAt); err != nil {
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
			return
		}
		pkg.Description = doctorsNullStr(description)
		packages = append(packages, pkg)
	}
	if err := rows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
		return
	}
	s.doctorsOK(w, http.StatusOK, packages)
}

func (s *Server) doctorsGetMyPackages(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT p.id, p.packageId, p.sessionsLeft, p.status, p.paidAt, p.createdAt, "+
			"pk.id, pk.name, pk.description, pk.sessionCount, pk.totalPrice, d.id, u.name "+
			"FROM `PackagePurchase` p "+
			"JOIN `Package` pk ON pk.id = p.packageId "+
			"JOIN `Doctor` d ON d.id = pk.doctorId "+
			"JOIN `User` u ON u.id = d.userId "+
			"WHERE p.userId = ? ORDER BY p.createdAt DESC", user.ID)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
		return
	}
	defer rows.Close()
	purchases := []doctorsMyPurchase{}
	for rows.Next() {
		var (
			purchase    doctorsMyPurchase
			paidAt      sql.NullTime
			description sql.NullString
			doctorName  sql.NullString
		)
		if err := rows.Scan(&purchase.ID, &purchase.PackageID, &purchase.SessionsLeft, &purchase.Status, &paidAt, &purchase.CreatedAt,
			&purchase.Package.ID, &purchase.Package.Name, &description, &purchase.Package.SessionCount, &purchase.Package.TotalPrice,
			&purchase.Package.Doctor.ID, &doctorName); err != nil {
			s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
			return
		}
		if paidAt.Valid {
			v := JSTime(paidAt.Time)
			purchase.PaidAt = &v
		}
		purchase.Package.Description = doctorsNullStr(description)
		purchase.Package.Doctor.User.Name = doctorsNullStr(doctorName)
		purchases = append(purchases, purchase)
	}
	if err := rows.Err(); err != nil {
		s.doctorsFail(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
		return
	}
	s.doctorsOK(w, http.StatusOK, purchases)
}

func (s *Server) doctorsCreatePackage(w http.ResponseWriter, r *http.Request) {
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	body, ok := s.doctorsJSONBody(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var verificationStatus string
	err := s.DB.QueryRowContext(ctx, "SELECT verificationStatus FROM `Doctor` WHERE id = ?", doctorID).Scan(&verificationStatus)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Doctor profile not found")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create package.")
		return
	}
	if verificationStatus != "approved" {
		s.Fail(w, http.StatusBadRequest, "Your profile must be verified before you can offer packages")
		return
	}

	name, nameOK := body["name"].(string)
	if !nameOK || strings.TrimSpace(name) == "" {
		s.Fail(w, http.StatusBadRequest, "Package name is required")
		return
	}
	sessionCount, sessionOK := doctorsBodyInt(body, "sessionCount")
	if !sessionOK || sessionCount < 1 || sessionCount > 20 {
		s.Fail(w, http.StatusBadRequest, "Session count must be 1-20")
		return
	}
	totalPrice, priceOK := doctorsBodyInt(body, "totalPrice")
	if !priceOK || totalPrice <= 0 {
		s.Fail(w, http.StatusBadRequest, "Total price must be positive")
		return
	}
	if totalPrice > 100_000_000 {
		s.Fail(w, http.StatusBadRequest, "Total price is unrealistically high")
		return
	}

	var description *string
	if raw, present := body["description"]; present && raw != nil {
		if str, isStr := raw.(string); isStr && str != "" {
			cleaned := s.doctorsSanitizeText(str)
			if cleaned != "" {
				description = &cleaned
			}
		}
	}

	now := time.Now().UTC()
	pkg := doctorsPackageRow{
		ID:           newID(),
		DoctorID:     doctorID,
		Name:         strings.TrimSpace(name),
		Description:  description,
		SessionCount: sessionCount,
		TotalPrice:   totalPrice,
		Active:       true,
		CreatedAt:    jsTimeValue(now),
	}
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `Package` (id, doctorId, name, description, sessionCount, totalPrice, active, createdAt) VALUES (?,?,?,?,?,?,?,?)",
		pkg.ID, doctorID, pkg.Name, description, sessionCount, totalPrice, true, now)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to create package.")
		return
	}
	s.doctorsOK(w, http.StatusCreated, &pkg)
}

func doctorsBodyInt(body map[string]any, key string) (int, bool) {
	v, ok := body[key].(float64)
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) || v != math.Trunc(v) || v < math.MinInt32 || v > math.MaxInt32 {
		return 0, false
	}
	return int(v), true
}

func (s *Server) doctorsDeletePackage(w http.ResponseWriter, r *http.Request) {
	packageID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	doctorID, ok := s.doctorsDoctorProfileID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var id string
	err := s.DB.QueryRowContext(ctx, "SELECT id FROM `Package` WHERE id = ? AND doctorId = ?", packageID, doctorID).Scan(&id)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Package not found")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to delete package.")
		return
	}
	if _, err := s.DB.ExecContext(ctx, "UPDATE `Package` SET active = FALSE WHERE id = ?", packageID); err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to delete package.")
		return
	}
	s.doctorsOK(w, http.StatusOK, map[string]any{"success": true})
}

// doctorsPurchasePackage ports DoctorService.purchasePackage exactly as the
// controller calls it: the patient path (no paidAt, no admin grant) is refused
// and only an administrator grant creates a PackagePurchase row. The route does
// not touch the payment provider.
func (s *Server) doctorsPurchasePackage(w http.ResponseWriter, r *http.Request) {
	packageID, ok := s.doctorsIDParam(w, r)
	if !ok {
		return
	}
	user := CurrentUser(r)
	ctx := r.Context()

	var pkg doctorsPurchasePackage
	var description sql.NullString
	err := s.DB.QueryRowContext(ctx,
		"SELECT p.id, p.doctorId, p.name, p.description, p.sessionCount, p.totalPrice, p.active, p.createdAt, "+
			"d.verificationStatus, d.userId "+
			"FROM `Package` p JOIN `Doctor` d ON d.id = p.doctorId "+
			"WHERE p.id = ? AND p.active = TRUE", packageID).
		Scan(&pkg.ID, &pkg.DoctorID, &pkg.Name, &description, &pkg.SessionCount, &pkg.TotalPrice, &pkg.Active, &pkg.CreatedAt,
			&pkg.Doctor.VerificationStatus, &pkg.Doctor.UserID)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Package not found or inactive")
		return
	}
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to purchase package.")
		return
	}
	pkg.Description = doctorsNullStr(description)
	if pkg.Doctor.VerificationStatus != "approved" {
		s.Fail(w, http.StatusBadRequest, "This package is not currently available")
		return
	}

	var grantedBy *string
	if user.Role == "admin" {
		grantedBy = &user.ID
	}
	if grantedBy == nil {
		s.Fail(w, http.StatusBadRequest, "This package requires payment before it can be added to your account")
		return
	}

	now := time.Now().UTC()
	purchase := doctorsPurchaseResponse{
		ID:              newID(),
		PackageID:       pkg.ID,
		UserID:          user.ID,
		SessionsLeft:    pkg.SessionCount,
		Status:          "active",
		GrantedByUserID: grantedBy,
		TotalPrice:      pkg.TotalPrice,
		SessionCount:    pkg.SessionCount,
		CreatedAt:       jsTimeValue(now),
		Package:         pkg,
	}
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `PackagePurchase` (id, packageId, userId, sessionsLeft, status, paidAt, grantedByUserId, totalPrice, sessionCount, reference, liveKey, createdAt) "+
			"VALUES (?,?,?,?,?,NULL,?,?,?,NULL,NULL,?)",
		purchase.ID, pkg.ID, user.ID, pkg.SessionCount, "active", grantedBy, pkg.TotalPrice, pkg.SessionCount, now)
	if err != nil {
		s.doctorsFail(w, r, err, http.StatusBadRequest, "Failed to purchase package.")
		return
	}
	s.doctorsOK(w, http.StatusCreated, &purchase)
}
