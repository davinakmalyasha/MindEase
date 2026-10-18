package server

// Port of server/src/routes/carePlan.routes.ts, controllers/carePlan.controller.ts,
// services/carePlan.service.ts and schemas/carePlan.schema.ts.
//
// Two documents with opposite ownership models, in one file because they
// answer the same question from opposite ends. A care plan is patient-owned;
// a treating clinician contributes goals and steps to it. A safety plan is
// patient-owned outright and a clinician only ever reads it or records a
// review.
//
// The version guard is the point of this domain: CarePlan.version and
// SafetyPlan.version, written with a conditional
// `UPDATE ... WHERE id = ? AND version = ?`, where zero rows affected becomes
// the exact 409 the Node service returns. A check-then-write would silently
// lose the other editor's work.
//
// Every helper here is care-prefixed: one domain, one package.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
)

/* ------------------------------------------------------------------ *
 * Routes (carePlan.routes.ts)
 * ------------------------------------------------------------------ */

func (s *Server) registerCare(api chi.Router) {
	api.Group(func(api chi.Router) {
		api.Use(s.authenticate)

		// The patient's own plan, created on first read so a patient
		// returning after weeks starts from their existing plan rather than
		// an empty screen.
		api.Get("/care-plan", s.handleCarePlanGetMine)
		// Every plan, closed ones included.
		api.Get("/care-plan/all", s.handleCarePlanList)
		// The clinician-facing read: requireDoctor plus the service's own
		// relationship check, exactly like the safety plan. Without it a
		// treating clinician could write goals into a document they had no
		// way to read back.
		api.With(s.careRequireDoctor).Get("/care-plan/patient/{id}", s.handleCarePlanForPatient)
		api.Put("/care-plan/{id}", s.handleCarePlanUpdate)

		// Goals and steps, writable by the patient or a treating clinician.
		// The access rule lives in the service, keyed off the plan's owner.
		api.Post("/care-plan/{id}/goals", s.handleCareGoalAdd)
		api.Put("/care-plan/goals/{id}", s.handleCareGoalUpdate)
		api.Delete("/care-plan/goals/{id}", s.handleCareGoalDelete)
		api.Post("/care-plan/goals/{id}/steps", s.handleCareStepAdd)
		api.Patch("/care-plan/steps/{id}", s.handleCareStepSetDone)

		// Patient-owned and never generated. `getMine`/`saveMine` take no
		// patient id: the only patient a caller can act on is themselves.
		api.Get("/safety-plan", s.handleSafetyPlanGetMine)
		api.Put("/safety-plan", s.handleSafetyPlanSave)
		// The clinician-facing read, separate so the access check is visible
		// at the route rather than implied by a query parameter.
		api.With(s.careRequireDoctor).Get("/safety-plan/patient/{id}", s.handleSafetyPlanForPatient)
		api.With(s.careRequireDoctor).Post("/safety-plan/patient/{id}/reviewed", s.handleSafetyPlanReviewed)
	})
}

// careRequireDoctor mirrors middleware/role.middleware.ts requireDoctor,
// including its exact 403 message.
func (s *Server) careRequireDoctor(next http.Handler) http.Handler {
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

/* ------------------------------------------------------------------ *
 * Controller envelope
 * ------------------------------------------------------------------ */

const (
	carePlanConflictMessage   = "This care plan was changed by someone else while you were editing. Reload to see their version."
	careSafetyConflictMessage = "This safety plan was changed by someone else while you were editing. Reload to see their version."
)

var (
	carePlanStatuses      = []string{"active", "completed", "paused"}
	careGoalStatuses      = []string{"open", "in_progress", "achieved", "paused", "dropped"}
	carePlanStatusMessage = `Invalid option: expected one of "active"|"completed"|"paused"`
	careGoalStatusMessage = `Invalid option: expected one of "open"|"in_progress"|"achieved"|"paused"|"dropped"`
)

// careOK is the shared handler's `res.json({ status: "success", data })`.
// Every route in the Node file answers 200, deletes included.
func (s *Server) careOK(w http.ResponseWriter, data any) {
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

// careFail mirrors `publicMessageFor(error) ?? { message: fallback, status: 500 }`:
// a typed domain error keeps its status and message; anything else is logged
// and becomes the controller's fixed fallback.
func (s *Server) careFail(w http.ResponseWriter, r *http.Request, err error, fallback string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("care handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, http.StatusInternalServerError, fallback)
}

/* ------------------------------------------------------------------ *
 * Validation, mirroring the Zod schemas and their message text
 * ------------------------------------------------------------------ */

var (
	careUUID7Pattern   = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	careISODateShape   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$`)
	careTitle160Msg    = "Too big: expected string to have <=160 characters"
	careTitle200Msg    = "Too big: expected string to have <=200 characters"
	careSection2000Msg = "Section too long"
	careSection4000Msg = "Section too long"
	careStr255Msg      = "Too big: expected string to have <=255 characters"
)

// careIDParam mirrors `validate(idParam)` for a route whose only parameter is
// `:id`.
func (s *Server) careIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if !careUUID7Pattern.MatchString(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return "", false
	}
	return id, true
}

// careObjectBody reads the body as a JSON object, preserving key order for the
// `Unrecognized key` message. A missing body is `{}`, like the Node validate
// middleware's `req.body ?? {}`; a JSON `null` behaves the same.
func careObjectBody(r *http.Request) (map[string]any, []string, string) {
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
		return nil, nil, "Invalid input: expected object, received " + careJSONType(tok)
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

func careJSONType(v any) string {
	switch v := v.(type) {
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
	case json.Delim:
		if v == '[' {
			return "array"
		}
		return "object"
	default:
		return "object"
	}
}

// careUnknownKeys mirrors Zod's `.strict()` rejection message.
func careUnknownKeys(keys []string, allowed ...string) string {
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

/* --- JavaScript-compatible string lengths -------------------------------- */

func careJSLen(s string) int {
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

func careSliceJS(s string, max int) string {
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

/* --- Sanitizer ----------------------------------------------------------- */

// careStripPolicy is Node's sanitize(): sanitize-html with `allowedTags: []`.
// StrictPolicy allows no elements at all; the default policy already skips
// script/style content, and textarea/option are added because sanitize-html's
// nonTextTags list includes them.
var careStripPolicy = bluemonday.StrictPolicy().SkipElementsContent("textarea", "option")

// careSanitizeText ports utils/sanitize.ts: trim, strip all markup, cap at
// 4000 UTF-16 code units.
func (s *Server) careSanitizeText(input string) string {
	cleaned := careStripPolicy.Sanitize(strings.TrimSpace(input))
	return careSliceJS(cleaned, 4000)
}

// careCleanSection is the safety plan's `clean(v, max)`: sanitize, cap, and
// `"" || null` so an emptied section clears to NULL.
func (s *Server) careCleanSection(value *string, max int) *string {
	if value == nil {
		return nil
	}
	cleaned := s.careSanitizeText(*value)
	if max > 0 {
		cleaned = careSliceJS(cleaned, max)
	}
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

/* --- Dates (the `dateOrNull` schema) ------------------------------------- */

func careAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// careParseJSDate mirrors V8's parse of the shapes careISODateShape admits:
// a date-only string is UTC, a date-time without `Z` is local, `T24:00` rolls
// forward, any fraction digits truncate to milliseconds, and calendar
// overflow inside a month rolls over the way `new Date` does.
func careParseJSDate(v string) (time.Time, bool) {
	if len(v) < 10 {
		return time.Time{}, false
	}
	y, err1 := strconv.Atoi(v[0:4])
	mo, err2 := strconv.Atoi(v[5:7])
	d, err3 := strconv.Atoi(v[8:10])
	if err1 != nil || err2 != nil || err3 != nil {
		return time.Time{}, false
	}
	// V8 rejects a month outside 1-12 or a day outside 1-31; a day inside
	// 1-31 that overflows the month rolls into the next one.
	if mo < 1 || mo > 12 || d < 1 || d > 31 {
		return time.Time{}, false
	}
	if len(v) == 10 {
		return time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC), true
	}
	if len(v) < 12 || v[10] != 'T' {
		return time.Time{}, false
	}
	rest := v[11:]
	loc := time.Local
	if strings.HasSuffix(rest, "Z") {
		loc = time.UTC
		rest = rest[:len(rest)-1]
	}
	// V8 requires at least HH:MM whenever a time part is present.
	if len(rest) < 2 || !careAllDigits(rest[:2]) {
		return time.Time{}, false
	}
	hh, _ := strconv.Atoi(rest[:2])
	rest = rest[2:]
	mm, ss, ms := 0, 0, 0
	if rest == "" || rest[0] != ':' {
		return time.Time{}, false
	}
	rest = rest[1:]
	if len(rest) < 2 || !careAllDigits(rest[:2]) {
		return time.Time{}, false
	}
	mm, _ = strconv.Atoi(rest[:2])
	rest = rest[2:]
	if rest != "" {
		if rest[0] != ':' {
			return time.Time{}, false
		}
		rest = rest[1:]
		if len(rest) < 2 || !careAllDigits(rest[:2]) {
			return time.Time{}, false
		}
		ss, _ = strconv.Atoi(rest[:2])
		rest = rest[2:]
		if rest != "" {
			if rest[0] != '.' || len(rest) == 1 || !careAllDigits(rest[1:]) {
				return time.Time{}, false
			}
			frac := rest[1:]
			if len(frac) > 3 {
				frac = frac[:3]
			}
			for len(frac) < 3 {
				frac += "0"
			}
			ms, _ = strconv.Atoi(frac)
		}
	}
	// Hour 24 is accepted only as a whole-day rollover.
	if hh > 24 || mm > 59 || ss > 59 {
		return time.Time{}, false
	}
	if hh == 24 && (mm != 0 || ss != 0 || ms != 0) {
		return time.Time{}, false
	}
	return time.Date(y, time.Month(mo), d, hh, mm, ss, ms*int(time.Millisecond), loc), true
}

// careDateValue validates one present, non-null `dateOrNull` field. The
// messages are the schema's: the shape regex first, then the calendar
// round-trip.
func careDateValue(v any) (*time.Time, string) {
	str, ok := v.(string)
	if !ok {
		return nil, "Invalid input: expected string, received " + careJSONType(v)
	}
	if !careISODateShape.MatchString(str) {
		return nil, "Expected an ISO date"
	}
	inst, ok := careParseJSDate(str)
	if !ok || inst.UTC().Format("2006-01-02") != str[0:10] {
		return nil, "Not a real calendar date"
	}
	return &inst, ""
}

func careTimeOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

/* --- Numbers (z.coerce.number().int()) ----------------------------------- */

func careCoercedNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case json.Number:
		return careParseJSNumber(t.String())
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return careParseJSNumber(t)
	case []any:
		switch len(t) {
		case 0:
			return 0
		case 1:
			return careCoercedNumber(t[0])
		default:
			return math.NaN()
		}
	default:
		return math.NaN()
	}
}

// careParseJSNumber follows JS `Number(string)` where it matters for coercion:
// whitespace-only is 0, Infinity/NaN round-trip, and anything else
// unparseable is NaN.
func careParseJSNumber(s string) float64 {
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

// careIntValue mirrors `z.coerce.number().int().min(0)`.
func careIntValue(v any, min int, minMsg string) (int, string) {
	f := careCoercedNumber(v)
	if math.IsNaN(f) {
		return 0, "Invalid input: expected number, received NaN"
	}
	if math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, "Invalid input: expected int, received number"
	}
	if f < float64(min) {
		return 0, minMsg
	}
	return int(f), ""
}

// careRequiredVersion is the care plan's required `version`. Omitting it is a
// 400 rather than a silent last-write-wins.
func careRequiredVersion(body map[string]any) (int, string) {
	v, present := body["version"]
	if !present {
		return 0, "Invalid input: expected number, received NaN"
	}
	return careIntValue(v, 0, "Too small: expected number to be >=0")
}

func careOptionalVersion(body map[string]any) (int, bool, string) {
	v, present := body["version"]
	if !present {
		return 0, false, ""
	}
	n, msg := careIntValue(v, 0, "Too small: expected number to be >=0")
	return n, true, msg
}

/* --- Field validators ---------------------------------------------------- */

// careNullableSection is `z.string().max(max, maxMsg).nullable().optional()`.
func careNullableSection(v any, max int, maxMsg string) (*string, string) {
	switch t := v.(type) {
	case nil:
		return nil, ""
	case string:
		if careJSLen(t) > max {
			return nil, maxMsg
		}
		return &t, ""
	default:
		return nil, "Invalid input: expected string, received " + careJSONType(v)
	}
}

/* --- Schemas ------------------------------------------------------------- */

type carePlanPatch struct {
	titleSet    bool
	title       string
	summarySet  bool
	summary     string
	statusSet   bool
	status      string
	reviewAtSet bool
	reviewAt    *time.Time
	version     int
}

func (s *Server) careValidateUpdatePlanBody(w http.ResponseWriter, body map[string]any, keys []string) (carePlanPatch, bool) {
	var p carePlanPatch
	if v, present := body["title"]; present {
		switch t := v.(type) {
		case nil:
			s.validationFail(w, "body.title", "Invalid input: expected string, received null")
			return p, false
		case string:
			if careJSLen(t) < 1 {
				s.validationFail(w, "body.title", "Too small: expected string to have >=1 characters")
				return p, false
			}
			if careJSLen(t) > 160 {
				s.validationFail(w, "body.title", careTitle160Msg)
				return p, false
			}
			p.titleSet, p.title = true, t
		default:
			s.validationFail(w, "body.title", "Invalid input: expected string, received "+careJSONType(v))
			return p, false
		}
	}
	if v, present := body["summary"]; present {
		switch t := v.(type) {
		case nil:
			// sanitize(null) is "", and sanitize("") is "", so both clear the
			// summary to an empty string rather than NULL.
			p.summarySet, p.summary = true, ""
		case string:
			if careJSLen(t) > 4000 {
				s.validationFail(w, "body.summary", careSection4000Msg)
				return p, false
			}
			p.summarySet, p.summary = true, s.careSanitizeText(t)
		default:
			s.validationFail(w, "body.summary", "Invalid input: expected string, received "+careJSONType(v))
			return p, false
		}
	}
	if v, present := body["status"]; present {
		str, ok := v.(string)
		if !ok || !containsString(carePlanStatuses, str) {
			s.validationFail(w, "body.status", carePlanStatusMessage)
			return p, false
		}
		p.statusSet, p.status = true, str
	}
	if v, present := body["reviewAt"]; present {
		if v == nil {
			p.reviewAtSet = true
		} else {
			at, msg := careDateValue(v)
			if msg != "" {
				s.validationFail(w, "body.reviewAt", msg)
				return p, false
			}
			p.reviewAtSet, p.reviewAt = true, at
		}
	}
	version, msg := careRequiredVersion(body)
	if msg != "" {
		s.validationFail(w, "body.version", msg)
		return p, false
	}
	p.version = version
	if msg := careUnknownKeys(keys, "title", "summary", "status", "reviewAt", "version"); msg != "" {
		s.validationFail(w, "body", msg)
		return p, false
	}
	return p, true
}

type careGoalInput struct {
	title      string
	detail     *string
	targetDate *time.Time
}

func (s *Server) careValidateCreateGoalBody(w http.ResponseWriter, body map[string]any, keys []string) (careGoalInput, bool) {
	var out careGoalInput
	raw, present := body["title"]
	switch t := raw.(type) {
	case nil:
		msg := "Invalid input: expected string, received undefined"
		if present {
			msg = "Invalid input: expected string, received null"
		}
		s.validationFail(w, "body.title", msg)
		return out, false
	case string:
		if careJSLen(t) < 1 {
			s.validationFail(w, "body.title", "Give the goal a title")
			return out, false
		}
		if careJSLen(t) > 200 {
			s.validationFail(w, "body.title", careTitle200Msg)
			return out, false
		}
		out.title = t
	default:
		s.validationFail(w, "body.title", "Invalid input: expected string, received "+careJSONType(raw))
		return out, false
	}
	if v, present := body["detail"]; present {
		switch t := v.(type) {
		case nil:
			// stays null
		case string:
			if careJSLen(t) > 2000 {
				s.validationFail(w, "body.detail", careSection2000Msg)
				return out, false
			}
			// `input.detail ? sanitize(input.detail) : null`: only a
			// non-empty string reaches the sanitizer.
			if t != "" {
				cleaned := s.careSanitizeText(t)
				out.detail = &cleaned
			}
		default:
			s.validationFail(w, "body.detail", "Invalid input: expected string, received "+careJSONType(v))
			return out, false
		}
	}
	if v, present := body["targetDate"]; present {
		if v != nil {
			at, msg := careDateValue(v)
			if msg != "" {
				s.validationFail(w, "body.targetDate", msg)
				return out, false
			}
			out.targetDate = at
		}
	}
	if msg := careUnknownKeys(keys, "title", "detail", "targetDate"); msg != "" {
		s.validationFail(w, "body", msg)
		return out, false
	}
	return out, true
}

type careGoalPatch struct {
	titleSet      bool
	title         string
	detailSet     bool
	detail        *string
	statusSet     bool
	status        string
	targetDateSet bool
	targetDate    *time.Time
}

func (s *Server) careValidateUpdateGoalBody(w http.ResponseWriter, body map[string]any, keys []string) (careGoalPatch, bool) {
	var p careGoalPatch
	if v, present := body["title"]; present {
		switch t := v.(type) {
		case nil:
			s.validationFail(w, "body.title", "Invalid input: expected string, received null")
			return p, false
		case string:
			if careJSLen(t) < 1 {
				s.validationFail(w, "body.title", "Too small: expected string to have >=1 characters")
				return p, false
			}
			if careJSLen(t) > 200 {
				s.validationFail(w, "body.title", careTitle200Msg)
				return p, false
			}
			p.titleSet, p.title = true, t
		default:
			s.validationFail(w, "body.title", "Invalid input: expected string, received "+careJSONType(v))
			return p, false
		}
	}
	if v, present := body["detail"]; present {
		switch t := v.(type) {
		case nil:
			// `patch.detail ? sanitize : null`: null clears.
			p.detailSet, p.detail = true, nil
		case string:
			if careJSLen(t) > 2000 {
				s.validationFail(w, "body.detail", careSection2000Msg)
				return p, false
			}
			p.detailSet = true
			if t == "" {
				p.detail = nil
			} else {
				cleaned := s.careSanitizeText(t)
				p.detail = &cleaned
			}
		default:
			s.validationFail(w, "body.detail", "Invalid input: expected string, received "+careJSONType(v))
			return p, false
		}
	}
	if v, present := body["status"]; present {
		str, ok := v.(string)
		if !ok || !containsString(careGoalStatuses, str) {
			s.validationFail(w, "body.status", careGoalStatusMessage)
			return p, false
		}
		p.statusSet, p.status = true, str
	}
	if v, present := body["targetDate"]; present {
		if v == nil {
			p.targetDateSet = true
		} else {
			at, msg := careDateValue(v)
			if msg != "" {
				s.validationFail(w, "body.targetDate", msg)
				return p, false
			}
			p.targetDateSet, p.targetDate = true, at
		}
	}
	if msg := careUnknownKeys(keys, "title", "detail", "status", "targetDate"); msg != "" {
		s.validationFail(w, "body", msg)
		return p, false
	}
	return p, true
}

func (s *Server) careValidateCreateStepBody(w http.ResponseWriter, body map[string]any, keys []string) (string, bool) {
	raw, present := body["title"]
	switch t := raw.(type) {
	case nil:
		msg := "Invalid input: expected string, received undefined"
		if present {
			msg = "Invalid input: expected string, received null"
		}
		s.validationFail(w, "body.title", msg)
		return "", false
	case string:
		if careJSLen(t) < 1 {
			s.validationFail(w, "body.title", "Give the step a title")
			return "", false
		}
		if careJSLen(t) > 200 {
			s.validationFail(w, "body.title", careTitle200Msg)
			return "", false
		}
		if msg := careUnknownKeys(keys, "title"); msg != "" {
			s.validationFail(w, "body", msg)
			return "", false
		}
		return t, true
	default:
		s.validationFail(w, "body.title", "Invalid input: expected string, received "+careJSONType(raw))
		return "", false
	}
}

func (s *Server) careValidateSetStepDoneBody(w http.ResponseWriter, body map[string]any, keys []string) (bool, bool) {
	v, present := body["done"]
	if !present {
		s.validationFail(w, "body.done", "Invalid input: expected boolean, received undefined")
		return false, false
	}
	done, ok := v.(bool)
	if !ok {
		s.validationFail(w, "body.done", "Invalid input: expected boolean, received "+careJSONType(v))
		return false, false
	}
	if msg := careUnknownKeys(keys, "done"); msg != "" {
		s.validationFail(w, "body", msg)
		return false, false
	}
	return done, true
}

type careSafetyPatch struct {
	warningSignsSet        bool
	warningSigns           *string
	copingStrategiesSet    bool
	copingStrategies       *string
	reasonsToLiveSet       bool
	reasonsToLive          *string
	contactsSet            bool
	contacts               *string
	professionalContactSet bool
	professionalContact    *string
	locationToBeSafeSet    bool
	locationToBeSafe       *string
	versionSet             bool
	version                int
}

func (s *Server) careValidateSaveSafetyBody(w http.ResponseWriter, body map[string]any, keys []string) (careSafetyPatch, bool) {
	var p careSafetyPatch
	sections := []struct {
		key    string
		max    int
		maxMsg string
	}{
		{"warningSigns", 4000, careSection4000Msg},
		{"copingStrategies", 4000, careSection4000Msg},
		{"reasonsToLive", 4000, careSection4000Msg},
		{"contacts", 2000, careSection2000Msg},
		{"professionalContact", 255, careStr255Msg},
		{"locationToBeSafe", 255, careStr255Msg},
	}
	values := make([]*string, len(sections))
	for i, f := range sections {
		v, present := body[f.key]
		if !present {
			continue
		}
		value, msg := careNullableSection(v, f.max, f.maxMsg)
		if msg != "" {
			s.validationFail(w, "body."+f.key, msg)
			return p, false
		}
		// undefined is dropped by Prisma; null and "" clear to NULL.
		values[i] = s.careCleanSection(value, f.max)
	}
	version, versionSet, msg := careOptionalVersion(body)
	if msg != "" {
		s.validationFail(w, "body.version", msg)
		return p, false
	}
	if msg := careUnknownKeys(keys,
		"warningSigns", "copingStrategies", "reasonsToLive", "contacts",
		"professionalContact", "locationToBeSafe", "version"); msg != "" {
		s.validationFail(w, "body", msg)
		return p, false
	}
	_, p.warningSignsSet = body["warningSigns"]
	_, p.copingStrategiesSet = body["copingStrategies"]
	_, p.reasonsToLiveSet = body["reasonsToLive"]
	_, p.contactsSet = body["contacts"]
	_, p.professionalContactSet = body["professionalContact"]
	_, p.locationToBeSafeSet = body["locationToBeSafe"]
	p.warningSigns = values[0]
	p.copingStrategies = values[1]
	p.reasonsToLive = values[2]
	p.contacts = values[3]
	p.professionalContact = values[4]
	p.locationToBeSafe = values[5]
	p.versionSet, p.version = versionSet, version
	return p, true
}

/* ------------------------------------------------------------------ *
 * Rows and JSON shapes
 * ------------------------------------------------------------------ */

type careScanner interface{ Scan(dest ...any) error }

type carePlanRow struct {
	ID           string
	UserID       string
	DoctorUserID *string
	Title        string
	Status       string
	Summary      *string
	ReviewAt     *time.Time
	ClosedAt     *time.Time
	Version      int
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const carePlanColumns = "id, userId, doctorUserId, title, status, summary, reviewAt, closedAt, version, createdAt, updatedAt"

func scanCarePlan(sc careScanner) (*carePlanRow, error) {
	var p carePlanRow
	err := sc.Scan(&p.ID, &p.UserID, &p.DoctorUserID, &p.Title, &p.Status, &p.Summary,
		&p.ReviewAt, &p.ClosedAt, &p.Version, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (p *carePlanRow) json() map[string]any {
	return map[string]any{
		"id":           p.ID,
		"userId":       p.UserID,
		"doctorUserId": p.DoctorUserID,
		"title":        p.Title,
		"status":       p.Status,
		"summary":      p.Summary,
		"reviewAt":     jsTime(p.ReviewAt),
		"closedAt":     jsTime(p.ClosedAt),
		"version":      p.Version,
		"createdAt":    jsTimeValue(p.CreatedAt),
		"updatedAt":    jsTimeValue(p.UpdatedAt),
	}
}

type careGoalRow struct {
	ID         string
	CarePlanID string
	Title      string
	Detail     *string
	Status     string
	TargetDate *time.Time
	Order      int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

func scanCareGoal(sc careScanner) (*careGoalRow, error) {
	var g careGoalRow
	err := sc.Scan(&g.ID, &g.CarePlanID, &g.Title, &g.Detail, &g.Status, &g.TargetDate,
		&g.Order, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &g, nil
}

func (g *careGoalRow) json() map[string]any {
	return map[string]any{
		"id":         g.ID,
		"carePlanId": g.CarePlanID,
		"title":      g.Title,
		"detail":     g.Detail,
		"status":     g.Status,
		"targetDate": jsTime(g.TargetDate),
		"order":      g.Order,
		"createdAt":  jsTimeValue(g.CreatedAt),
		"updatedAt":  jsTimeValue(g.UpdatedAt),
	}
}

type careStepRow struct {
	ID         string
	CareGoalID string
	Title      string
	Done       bool
	DoneAt     *time.Time
	Order      int
	CreatedAt  time.Time
}

func scanCareStep(sc careScanner) (*careStepRow, error) {
	var st careStepRow
	err := sc.Scan(&st.ID, &st.CareGoalID, &st.Title, &st.Done, &st.DoneAt, &st.Order, &st.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &st, nil
}

func (st *careStepRow) json() map[string]any {
	return map[string]any{
		"id":         st.ID,
		"careGoalId": st.CareGoalID,
		"title":      st.Title,
		"done":       st.Done,
		"doneAt":     jsTime(st.DoneAt),
		"order":      st.Order,
		"createdAt":  jsTimeValue(st.CreatedAt),
	}
}

type careSafetyRow struct {
	ID                  string
	UserID              string
	WarningSigns        *string
	CopingStrategies    *string
	ReasonsToLive       *string
	Contacts            *string
	ProfessionalContact *string
	LocationToBeSafe    *string
	LastReviewedAt      *time.Time
	Version             int
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

const careSafetyColumns = "id, userId, warningSigns, copingStrategies, reasonsToLive, contacts, professionalContact, locationToBeSafe, lastReviewedAt, version, createdAt, updatedAt"

func scanCareSafety(sc careScanner) (*careSafetyRow, error) {
	var p careSafetyRow
	err := sc.Scan(&p.ID, &p.UserID, &p.WarningSigns, &p.CopingStrategies, &p.ReasonsToLive,
		&p.Contacts, &p.ProfessionalContact, &p.LocationToBeSafe, &p.LastReviewedAt,
		&p.Version, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (p *careSafetyRow) json() map[string]any {
	return map[string]any{
		"id":                  p.ID,
		"userId":              p.UserID,
		"warningSigns":        p.WarningSigns,
		"copingStrategies":    p.CopingStrategies,
		"reasonsToLive":       p.ReasonsToLive,
		"contacts":            p.Contacts,
		"professionalContact": p.ProfessionalContact,
		"locationToBeSafe":    p.LocationToBeSafe,
		"lastReviewedAt":      jsTime(p.LastReviewedAt),
		"version":             p.Version,
		"createdAt":           jsTimeValue(p.CreatedAt),
		"updatedAt":           jsTimeValue(p.UpdatedAt),
	}
}

func (s *Server) carePlanByID(ctx context.Context, id string) (*carePlanRow, error) {
	row, err := scanCarePlan(s.DB.QueryRowContext(ctx,
		"SELECT "+carePlanColumns+" FROM `CarePlan` WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return nil, NotFound("Care plan not found")
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

func (s *Server) careSafetyByUser(ctx context.Context, userID string) (*careSafetyRow, error) {
	return scanCareSafety(s.DB.QueryRowContext(ctx,
		"SELECT "+careSafetyColumns+" FROM `SafetyPlan` WHERE userId = ?", userID))
}

func (s *Server) careSafetyByID(ctx context.Context, id string) (*careSafetyRow, error) {
	return scanCareSafety(s.DB.QueryRowContext(ctx,
		"SELECT "+careSafetyColumns+" FROM `SafetyPlan` WHERE id = ?", id))
}

func (s *Server) careStepByID(ctx context.Context, id string) (*careStepRow, error) {
	row, err := scanCareStep(s.DB.QueryRowContext(ctx,
		"SELECT id, careGoalId, title, done, doneAt, `order`, createdAt FROM `CareStep` WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return nil, NotFound("Step not found")
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// careGoalWithOwner resolves a goal through its plan to the owner, the join
// that makes the ownership check impossible to skip.
func (s *Server) careGoalWithOwner(ctx context.Context, goalID string) (*careGoalRow, string, error) {
	var g careGoalRow
	var ownerID string
	err := s.DB.QueryRowContext(ctx,
		"SELECT g.id, g.carePlanId, g.title, g.detail, g.status, g.targetDate, g.`order`, "+
			"g.createdAt, g.updatedAt, p.userId "+
			"FROM `CareGoal` g JOIN `CarePlan` p ON p.id = g.carePlanId WHERE g.id = ?", goalID).
		Scan(&g.ID, &g.CarePlanID, &g.Title, &g.Detail, &g.Status, &g.TargetDate,
			&g.Order, &g.CreatedAt, &g.UpdatedAt, &ownerID)
	if err == sql.ErrNoRows {
		return nil, "", NotFound("Goal not found")
	}
	if err != nil {
		return nil, "", err
	}
	return &g, ownerID, nil
}

// carePlanGoals is the Prisma include: goals ordered, with their steps
// ordered.
func (s *Server) carePlanGoals(ctx context.Context, planID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, carePlanId, title, detail, status, targetDate, `order`, createdAt, updatedAt "+
			"FROM `CareGoal` WHERE carePlanId = ? ORDER BY `order` ASC, id ASC", planID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var goals []*careGoalRow
	for rows.Next() {
		g, err := scanCareGoal(rows)
		if err != nil {
			return nil, err
		}
		goals = append(goals, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(goals))
	for _, g := range goals {
		m := g.json()
		steps, err := s.careGoalSteps(ctx, g.ID)
		if err != nil {
			return nil, err
		}
		m["steps"] = steps
		out = append(out, m)
	}
	return out, nil
}

func (s *Server) careGoalSteps(ctx context.Context, goalID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, careGoalId, title, done, doneAt, `order`, createdAt "+
			"FROM `CareStep` WHERE careGoalId = ? ORDER BY `order` ASC, id ASC", goalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		st, err := scanCareStep(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st.json())
	}
	return out, rows.Err()
}

// carePlanJSON is a plan with its three-level eager load.
func (s *Server) carePlanJSON(ctx context.Context, plan *carePlanRow) (map[string]any, error) {
	out := plan.json()
	goals, err := s.carePlanGoals(ctx, plan.ID)
	if err != nil {
		return nil, err
	}
	out["goals"] = goals
	return out, nil
}

/* ------------------------------------------------------------------ *
 * Ownership (assertMayContribute / assertMayRead) and audit reads
 * ------------------------------------------------------------------ */

// careAssertMayContribute is the service's `assertMayContribute`: the owner,
// or a doctor with a confirmed/completed appointment. An admin is
// deliberately not given blanket access.
func (s *Server) careAssertMayContribute(ctx context.Context, actor *UserCtx, patientID string) error {
	if actor.ID == patientID {
		return nil
	}
	if actor.Role == "doctor" {
		// The same live-relationship rule the risk queue uses; the query
		// lives in routes_wellness.go and is shared across clinical domains.
		treats, err := s.clinicalTreatsPatient(ctx, actor.ID, patientID)
		if err != nil {
			return err
		}
		if treats {
			return nil
		}
	}
	return Forbidden("not your patient")
}

// careAuditRead ports AuditService.logRead: action clinical.read, the reader
// and the patient recorded as separate facts, targetId null.
func (s *Server) careAuditRead(ctx context.Context, actorID, subjectType, patientID, via string) {
	target := subjectType
	s.audit(ctx, "clinical.read", &actorID, &target, nil, map[string]any{
		"subjectId": patientID,
		"via":       via,
	})
}

/* ------------------------------------------------------------------ *
 * Care plan service
 * ------------------------------------------------------------------ */

// careGetActivePlan is `getForPatient`: the active plan, auto-created on
// first read so the empty state is a plan with no goals rather than nothing.
func (s *Server) careGetActivePlan(ctx context.Context, patientID string) (map[string]any, error) {
	plan, err := scanCarePlan(s.DB.QueryRowContext(ctx,
		"SELECT "+carePlanColumns+" FROM `CarePlan` WHERE userId = ? AND status = 'active' "+
			"ORDER BY createdAt DESC LIMIT 1", patientID))
	if err == sql.ErrNoRows {
		id := newID()
		now := time.Now().UTC()
		_, err = s.DB.ExecContext(ctx,
			"INSERT INTO `CarePlan` (id, userId, title, status, version, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
			id, patientID, "My care plan", "active", 0, now, now)
		if err != nil {
			return nil, err
		}
		plan = &carePlanRow{
			ID: id, UserID: patientID, Title: "My care plan", Status: "active",
			Version: 0, CreatedAt: now, UpdatedAt: now,
		}
	} else if err != nil {
		return nil, err
	}
	return s.carePlanJSON(ctx, plan)
}

// careListPlans is `listForPatient(patientId, actor?)`: every plan, closed
// ones included, bounded to 20. A clinician reading somebody else's plan must
// have a live relationship, and the read is recorded. A patient's own call
// passes no actor and skips both.
func (s *Server) careListPlans(ctx context.Context, patientID string, actor *UserCtx) ([]map[string]any, error) {
	if actor != nil && actor.ID != patientID {
		if err := s.careAssertMayContribute(ctx, actor, patientID); err != nil {
			return nil, err
		}
		s.careAuditRead(ctx, actor.ID, "CarePlan", patientID, "GET /api/care-plan/patient/:id")
	}

	rows, err := s.DB.QueryContext(ctx,
		"SELECT "+carePlanColumns+" FROM `CarePlan` WHERE userId = ? ORDER BY createdAt DESC LIMIT 20", patientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var plans []*carePlanRow
	for rows.Next() {
		p, err := scanCarePlan(rows)
		if err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(plans))
	for _, p := range plans {
		m, err := s.carePlanJSON(ctx, p)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// careUpdatePlan is `updatePlan`: owner-only, and the write is conditional on
// the version the caller was shown. Zero rows affected is the 409.
func (s *Server) careUpdatePlan(ctx context.Context, actorID, planID string, patch carePlanPatch) (map[string]any, error) {
	var id, ownerID string
	var currentVersion int
	err := s.DB.QueryRowContext(ctx,
		"SELECT id, userId, version FROM `CarePlan` WHERE id = ?", planID).
		Scan(&id, &ownerID, &currentVersion)
	if err == sql.ErrNoRows {
		return nil, NotFound("Care plan not found")
	}
	if err != nil {
		return nil, err
	}
	// Patient-owned: a clinician contributes goals (addGoal), never a rewrite.
	if ownerID != actorID {
		return nil, Forbidden("not your care plan")
	}
	if patch.statusSet && !containsString(carePlanStatuses, patch.status) {
		return nil, BadRequest("Invalid plan status")
	}

	now := time.Now().UTC()
	sets := make([]string, 0, 7)
	args := make([]any, 0, 9)
	if patch.titleSet {
		sets = append(sets, "title = ?")
		args = append(args, careSliceJS(patch.title, 160))
	}
	if patch.summarySet {
		sets = append(sets, "summary = ?")
		args = append(args, patch.summary)
	}
	if patch.statusSet {
		sets = append(sets, "status = ?")
		args = append(args, patch.status)
		// Closing a plan stamps closedAt. "completed" and "paused" are both
		// terminal here; reopening does not clear the stamp.
		if patch.status != "active" {
			sets = append(sets, "closedAt = ?")
			args = append(args, now)
		}
	}
	if patch.reviewAtSet {
		sets = append(sets, "reviewAt = ?")
		args = append(args, careTimeOrNil(patch.reviewAt))
	}
	sets = append(sets, "version = version + 1", "updatedAt = ?")
	args = append(args, now, planID, patch.version)

	res, err := s.DB.ExecContext(ctx,
		"UPDATE `CarePlan` SET "+strings.Join(sets, ", ")+" WHERE id = ? AND version = ?", args...)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		// The write did not happen. A conflict rather than a silent success
		// is the entire point.
		return nil, Conflict(carePlanConflictMessage)
	}

	plan, err := s.carePlanByID(ctx, planID)
	if err != nil {
		return nil, err
	}
	out, err := s.carePlanJSON(ctx, plan)
	if err != nil {
		return nil, err
	}
	target := "CarePlan"
	s.audit(ctx, "careplan.updated", &actorID, &target, &planID, nil)
	return out, nil
}

// careAddGoal is `addGoal`: callable by the patient or their treating
// clinician, and additive on purpose. When a clinician contributes, the plan
// records them as the responsible doctor.
func (s *Server) careAddGoal(ctx context.Context, actor *UserCtx, planID string, input careGoalInput) (map[string]any, error) {
	var ownerID string
	err := s.DB.QueryRowContext(ctx, "SELECT userId FROM `CarePlan` WHERE id = ?", planID).Scan(&ownerID)
	if err == sql.ErrNoRows {
		return nil, NotFound("Care plan not found")
	}
	if err != nil {
		return nil, err
	}
	if err := s.careAssertMayContribute(ctx, actor, ownerID); err != nil {
		return nil, err
	}

	order := 0
	var lastOrder int
	err = s.DB.QueryRowContext(ctx,
		"SELECT `order` FROM `CareGoal` WHERE carePlanId = ? ORDER BY `order` DESC LIMIT 1", planID).Scan(&lastOrder)
	if err == nil {
		order = lastOrder + 1
	} else if err != sql.ErrNoRows {
		return nil, err
	}

	now := time.Now().UTC()
	title := careSliceJS(input.title, 200)
	goalID := newID()
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `CareGoal` (id, carePlanId, title, detail, status, targetDate, `order`, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?)",
		goalID, planID, title, nullableString(input.detail), "open", careTimeOrNil(input.targetDate), order, now, now)
	if err != nil {
		return nil, err
	}

	// When a clinician contributes, the plan is theirs to help carry.
	// Best-effort, and Prisma's @updatedAt moves on this update too.
	if actor.Role == "doctor" && ownerID != actor.ID {
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `CarePlan` SET doctorUserId = ?, updatedAt = ? WHERE id = ?",
			actor.ID, time.Now().UTC(), planID); err != nil {
			s.Log.Warn("care: failed to record the contributing clinician", "err", err)
		}
	}

	goal := &careGoalRow{
		ID: goalID, CarePlanID: planID, Title: title, Detail: input.detail,
		Status: "open", TargetDate: input.targetDate, Order: order, CreatedAt: now, UpdatedAt: now,
	}
	target := "CareGoal"
	s.audit(ctx, "careplan.goal_added", &actor.ID, &target, &goalID, map[string]any{
		"carePlanId": planID,
		"patientId":  ownerID,
	})
	return goal.json(), nil
}

// careUpdateGoal is `updateGoal`.
func (s *Server) careUpdateGoal(ctx context.Context, actor *UserCtx, goalID string, patch careGoalPatch) (map[string]any, error) {
	goal, ownerID, err := s.careGoalWithOwner(ctx, goalID)
	if err != nil {
		return nil, err
	}
	if err := s.careAssertMayContribute(ctx, actor, ownerID); err != nil {
		return nil, err
	}
	if patch.statusSet && !containsString(careGoalStatuses, patch.status) {
		return nil, BadRequest("Invalid goal status")
	}

	now := time.Now().UTC()
	sets := make([]string, 0, 5)
	args := make([]any, 0, 7)
	if patch.titleSet {
		sets = append(sets, "title = ?")
		args = append(args, careSliceJS(patch.title, 200))
	}
	if patch.detailSet {
		sets = append(sets, "detail = ?")
		args = append(args, nullableString(patch.detail))
	}
	if patch.statusSet {
		sets = append(sets, "status = ?")
		args = append(args, patch.status)
	}
	if patch.targetDateSet {
		sets = append(sets, "targetDate = ?")
		args = append(args, careTimeOrNil(patch.targetDate))
	}
	sets = append(sets, "updatedAt = ?")
	args = append(args, now, goalID)

	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `CareGoal` SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		return nil, err
	}

	if patch.titleSet {
		goal.Title = careSliceJS(patch.title, 200)
	}
	if patch.detailSet {
		goal.Detail = patch.detail
	}
	if patch.statusSet {
		goal.Status = patch.status
	}
	if patch.targetDateSet {
		goal.TargetDate = patch.targetDate
	}
	goal.UpdatedAt = now
	return goal.json(), nil
}

// careDeleteGoal is `deleteGoal`. Steps cascade by foreign key. The deleted
// row is the response, like Prisma's delete return.
func (s *Server) careDeleteGoal(ctx context.Context, actor *UserCtx, goalID string) (map[string]any, error) {
	goal, ownerID, err := s.careGoalWithOwner(ctx, goalID)
	if err != nil {
		return nil, err
	}
	if err := s.careAssertMayContribute(ctx, actor, ownerID); err != nil {
		return nil, err
	}
	if _, err := s.DB.ExecContext(ctx, "DELETE FROM `CareGoal` WHERE id = ?", goalID); err != nil {
		return nil, err
	}
	return goal.json(), nil
}

// careAddStep is `addStep`.
func (s *Server) careAddStep(ctx context.Context, actor *UserCtx, goalID, title string) (map[string]any, error) {
	var ownerID string
	err := s.DB.QueryRowContext(ctx,
		"SELECT p.userId FROM `CareGoal` g JOIN `CarePlan` p ON p.id = g.carePlanId WHERE g.id = ?", goalID).
		Scan(&ownerID)
	if err == sql.ErrNoRows {
		return nil, NotFound("Goal not found")
	}
	if err != nil {
		return nil, err
	}
	if err := s.careAssertMayContribute(ctx, actor, ownerID); err != nil {
		return nil, err
	}

	order := 0
	var lastOrder int
	err = s.DB.QueryRowContext(ctx,
		"SELECT `order` FROM `CareStep` WHERE careGoalId = ? ORDER BY `order` DESC LIMIT 1", goalID).Scan(&lastOrder)
	if err == nil {
		order = lastOrder + 1
	} else if err != sql.ErrNoRows {
		return nil, err
	}

	now := time.Now().UTC()
	step := &careStepRow{
		ID: newID(), CareGoalID: goalID, Title: careSliceJS(title, 200),
		Done: false, Order: order, CreatedAt: now,
	}
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `CareStep` (id, careGoalId, title, done, `order`, createdAt) VALUES (?,?,?,?,?,?)",
		step.ID, step.CareGoalID, step.Title, false, order, now)
	if err != nil {
		return nil, err
	}
	return step.json(), nil
}

// careSetStepDone is `setStepDone`: doneAt is maintained alongside done, not
// derived, because "when did they actually do this" is the clinically
// interesting question.
func (s *Server) careSetStepDone(ctx context.Context, actor *UserCtx, stepID string, done bool) (map[string]any, error) {
	var ownerID string
	err := s.DB.QueryRowContext(ctx,
		"SELECT p.userId FROM `CareStep` s "+
			"JOIN `CareGoal` g ON g.id = s.careGoalId "+
			"JOIN `CarePlan` p ON p.id = g.carePlanId WHERE s.id = ?", stepID).
		Scan(&ownerID)
	if err == sql.ErrNoRows {
		return nil, NotFound("Step not found")
	}
	if err != nil {
		return nil, err
	}
	if err := s.careAssertMayContribute(ctx, actor, ownerID); err != nil {
		return nil, err
	}

	var doneAt *time.Time
	if done {
		now := time.Now().UTC()
		doneAt = &now
	}
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `CareStep` SET done = ?, doneAt = ? WHERE id = ?",
		done, careTimeOrNil(doneAt), stepID); err != nil {
		return nil, err
	}
	step, err := s.careStepByID(ctx, stepID)
	if err != nil {
		return nil, err
	}
	return step.json(), nil
}

/* ------------------------------------------------------------------ *
 * Safety plan service
 * ------------------------------------------------------------------ */

// careGetSafetyPlan is `get(actor, patientId)`: null rather than an empty
// object when none exists, because the client distinguishes "not written
// yet" from "written and empty". A clinician opening someone else's is
// recorded; the patient opening their own is not.
func (s *Server) careGetSafetyPlan(ctx context.Context, actor *UserCtx, patientID string) (any, error) {
	if err := s.careAssertMayContribute(ctx, actor, patientID); err != nil {
		return nil, err
	}
	if actor.ID != patientID {
		s.careAuditRead(ctx, actor.ID, "SafetyPlan", patientID, "GET /api/safety-plan/patient/:id")
	}
	row, err := s.careSafetyByUser(ctx, patientID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return row.json(), nil
}

// careSaveSafetyPlan is `save`: a merge, not a replace. A field the caller
// did not mention is left alone; a field explicitly sent as null or an empty
// string is cleared. Existing rows are written with a conditional UPDATE
// against the version that was just read, so two writers cannot both win.
func (s *Server) careSaveSafetyPlan(ctx context.Context, actor *UserCtx, patientID string, patch careSafetyPatch) (map[string]any, error) {
	if err := s.careAssertMayContribute(ctx, actor, patientID); err != nil {
		return nil, err
	}

	var existingID string
	var existingVersion int
	err := s.DB.QueryRowContext(ctx,
		"SELECT id, version FROM `SafetyPlan` WHERE userId = ?", patientID).
		Scan(&existingID, &existingVersion)
	exists := err == nil
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}

	// Creating is not a conflict; only an update against a stale version is.
	if exists && patch.versionSet && existingVersion != patch.version {
		return nil, Conflict(careSafetyConflictMessage)
	}

	now := time.Now().UTC()
	var row *careSafetyRow
	if exists {
		sets := make([]string, 0, 9)
		args := make([]any, 0, 11)
		if patch.warningSignsSet {
			sets = append(sets, "warningSigns = ?")
			args = append(args, nullableString(patch.warningSigns))
		}
		if patch.copingStrategiesSet {
			sets = append(sets, "copingStrategies = ?")
			args = append(args, nullableString(patch.copingStrategies))
		}
		if patch.reasonsToLiveSet {
			sets = append(sets, "reasonsToLive = ?")
			args = append(args, nullableString(patch.reasonsToLive))
		}
		if patch.contactsSet {
			sets = append(sets, "contacts = ?")
			args = append(args, nullableString(patch.contacts))
		}
		if patch.professionalContactSet {
			sets = append(sets, "professionalContact = ?")
			args = append(args, nullableString(patch.professionalContact))
		}
		if patch.locationToBeSafeSet {
			sets = append(sets, "locationToBeSafe = ?")
			args = append(args, nullableString(patch.locationToBeSafe))
		}
		sets = append(sets, "version = version + 1", "updatedAt = ?")
		// `expected ?? existing.version`: a caller that sent no version still
		// gets a conditional write against the version we just read.
		expected := existingVersion
		if patch.versionSet {
			expected = patch.version
		}
		args = append(args, now, existingID, expected)

		res, err := s.DB.ExecContext(ctx,
			"UPDATE `SafetyPlan` SET "+strings.Join(sets, ", ")+" WHERE id = ? AND version = ?", args...)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, Conflict(careSafetyConflictMessage)
		}
		row, err = s.careSafetyByID(ctx, existingID)
		if err != nil {
			return nil, err
		}
	} else {
		row = &careSafetyRow{
			ID:                  newID(),
			UserID:              patientID,
			WarningSigns:        patch.warningSigns,
			CopingStrategies:    patch.copingStrategies,
			ReasonsToLive:       patch.reasonsToLive,
			Contacts:            patch.contacts,
			ProfessionalContact: patch.professionalContact,
			LocationToBeSafe:    patch.locationToBeSafe,
			Version:             0,
			CreatedAt:           now,
			UpdatedAt:           now,
		}
		_, err = s.DB.ExecContext(ctx,
			"INSERT INTO `SafetyPlan` (id, userId, warningSigns, copingStrategies, reasonsToLive, contacts, "+
				"professionalContact, locationToBeSafe, version, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			row.ID, patientID, nullableString(patch.warningSigns), nullableString(patch.copingStrategies),
			nullableString(patch.reasonsToLive), nullableString(patch.contacts),
			nullableString(patch.professionalContact), nullableString(patch.locationToBeSafe),
			0, now, now)
		if err != nil {
			return nil, err
		}
	}

	target := "SafetyPlan"
	s.audit(ctx, "safetyplan.saved", &actor.ID, &target, &row.ID, map[string]any{"patientId": patientID})
	return row.json(), nil
}

// careMarkSafetyReviewed records that a clinician reviewed the plan with the
// patient. Separate from saving on purpose, and not version-guarded: the
// review is a fact about what happened, not an edit to the document.
func (s *Server) careMarkSafetyReviewed(ctx context.Context, actor *UserCtx, patientID string) (map[string]any, error) {
	if actor.Role != "doctor" {
		return nil, Forbidden("only a clinician can record a review")
	}
	if err := s.careAssertMayContribute(ctx, actor, patientID); err != nil {
		return nil, err
	}
	row, err := s.careSafetyByUser(ctx, patientID)
	if err == sql.ErrNoRows {
		return nil, NotFound("This patient has not written a safety plan yet")
	}
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `SafetyPlan` SET lastReviewedAt = ?, updatedAt = ? WHERE id = ?",
		now, now, row.ID); err != nil {
		return nil, err
	}
	row.LastReviewedAt = &now
	row.UpdatedAt = now
	return row.json(), nil
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

func (s *Server) handleCarePlanGetMine(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	plan, err := s.careGetActivePlan(r.Context(), user.ID)
	if err != nil {
		s.careFail(w, r, err, "Failed to load your care plan.")
		return
	}
	s.careOK(w, plan)
}

func (s *Server) handleCarePlanList(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	plans, err := s.careListPlans(r.Context(), user.ID, nil)
	if err != nil {
		s.careFail(w, r, err, "Failed to load your care plans.")
		return
	}
	s.careOK(w, plans)
}

func (s *Server) handleCarePlanForPatient(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	patientID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	plans, err := s.careListPlans(r.Context(), patientID, user)
	if err != nil {
		s.careFail(w, r, err, "Failed to load the patient's care plan.")
		return
	}
	s.careOK(w, plans)
}

func (s *Server) handleCarePlanUpdate(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	patch, ok := s.careValidateUpdatePlanBody(w, body, keys)
	if !ok {
		return
	}
	planID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	plan, err := s.careUpdatePlan(r.Context(), user.ID, planID, patch)
	if err != nil {
		s.careFail(w, r, err, "Failed to update the care plan.")
		return
	}
	s.careOK(w, plan)
}

func (s *Server) handleCareGoalAdd(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	input, ok := s.careValidateCreateGoalBody(w, body, keys)
	if !ok {
		return
	}
	planID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	goal, err := s.careAddGoal(r.Context(), user, planID, input)
	if err != nil {
		s.careFail(w, r, err, "Failed to add the goal.")
		return
	}
	s.careOK(w, goal)
}

func (s *Server) handleCareGoalUpdate(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	patch, ok := s.careValidateUpdateGoalBody(w, body, keys)
	if !ok {
		return
	}
	goalID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	goal, err := s.careUpdateGoal(r.Context(), user, goalID, patch)
	if err != nil {
		s.careFail(w, r, err, "Failed to update the goal.")
		return
	}
	s.careOK(w, goal)
}

func (s *Server) handleCareGoalDelete(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	goalID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	goal, err := s.careDeleteGoal(r.Context(), user, goalID)
	if err != nil {
		s.careFail(w, r, err, "Failed to delete the goal.")
		return
	}
	s.careOK(w, goal)
}

func (s *Server) handleCareStepAdd(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	title, ok := s.careValidateCreateStepBody(w, body, keys)
	if !ok {
		return
	}
	goalID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	step, err := s.careAddStep(r.Context(), user, goalID, title)
	if err != nil {
		s.careFail(w, r, err, "Failed to add the step.")
		return
	}
	s.careOK(w, step)
}

func (s *Server) handleCareStepSetDone(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	done, ok := s.careValidateSetStepDoneBody(w, body, keys)
	if !ok {
		return
	}
	stepID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	step, err := s.careSetStepDone(r.Context(), user, stepID, done)
	if err != nil {
		s.careFail(w, r, err, "Failed to update the step.")
		return
	}
	s.careOK(w, step)
}

func (s *Server) handleSafetyPlanGetMine(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	plan, err := s.careGetSafetyPlan(r.Context(), user, user.ID)
	if err != nil {
		s.careFail(w, r, err, "Failed to load your safety plan.")
		return
	}
	s.careOK(w, plan)
}

func (s *Server) handleSafetyPlanSave(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	patch, ok := s.careValidateSaveSafetyBody(w, body, keys)
	if !ok {
		return
	}
	plan, err := s.careSaveSafetyPlan(r.Context(), user, user.ID, patch)
	if err != nil {
		s.careFail(w, r, err, "Failed to save your safety plan.")
		return
	}
	s.careOK(w, plan)
}

func (s *Server) handleSafetyPlanForPatient(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	patientID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	plan, err := s.careGetSafetyPlan(r.Context(), user, patientID)
	if err != nil {
		s.careFail(w, r, err, "Failed to load the safety plan.")
		return
	}
	s.careOK(w, plan)
}

func (s *Server) handleSafetyPlanReviewed(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	patientID, ok := s.careIDParam(w, r)
	if !ok {
		return
	}
	plan, err := s.careMarkSafetyReviewed(r.Context(), user, patientID)
	if err != nil {
		s.careFail(w, r, err, "Failed to record the review.")
		return
	}
	s.careOK(w, plan)
}
