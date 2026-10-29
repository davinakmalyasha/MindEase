package server

// Port of server/src/routes/ai.routes.ts with its controllers and services:
// ai.controller.ts, briefing.controller.ts, ai.service.ts and
// preSession.service.ts.
//
// Model calls go through the configured provider (ai.go: an OpenAI-compatible
// gateway, Command Code / DeepSeek V4.1 Flash by default). With no key, every
// surface serves the deterministic fallback branch Node uses for its degraded
// path and reports `source: "fallback"` with a degradedReason. Generated
// briefings persist `briefingSource` as "model" or "fallback", so a cached read
// still reports its origin. Patient text is fenced before it reaches a prompt;
// the crisis patterns stay in the wellness/support domain, so neither
// ai.controller.ts nor preSession.service.ts consults the safety branch.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

func (s *Server) registerAI(api chi.Router) {
	aiRate := s.limiter(rateLimitConfig{
		name:    "ai",
		window:  10 * time.Minute,
		max:     15,
		message: "Too many AI requests, please try again later",
	})

	// `GET /pre-session/:appointmentId` is deliberately unmetered: it is a pure
	// read of already-stored rows. The two POSTs are metered exactly as in the
	// Node route file.
	api.With(s.authenticate, aiRate).Post("/ai/pre-session", s.handleAIPreSessionQuestions)
	api.With(s.authenticate, s.aiValidateAppointmentIDParam).Get("/ai/pre-session/{appointmentId}", s.handleAIPreSessionData)
	api.With(s.authenticate, aiRate).Post("/ai/pre-session/answers", s.handleAIPreSessionAnswers)

	// Doctor clinical briefing (restricted). Middleware order mirrors the Node
	// chain: authenticate, then validate (param), then requireDoctor, then the
	// AI limiter.
	api.With(s.authenticate, s.aiRequireDoctor, aiRate).Post("/ai/briefing", s.handleAIBriefingGenerate)
	api.With(s.authenticate, s.aiValidateAppointmentIDParam, s.aiRequireDoctor, aiRate).
		Get("/ai/briefing/{appointmentId}", s.handleAIBriefingGet)

	// Clinician session-prep draft (restricted, ephemeral). Same gate as the
	// briefing: the assigned doctor only, never stored, always audited.
	api.With(s.authenticate, s.aiRequireDoctor, aiRate).Post("/ai/copilot-draft", s.handleAICopilotDraft)

	// Patient wellness suggestions.
	api.With(s.authenticate, aiRate).Post("/ai/resources", s.handleAIResources)

	// Doctor matching (natural-language search).
	api.With(s.authenticate, aiRate).Post("/ai/match-doctors", s.handleAIMatchDoctors)
}

/* ------------------------------------------------------------------ *
 * Auth and route-parameter middleware
 * ------------------------------------------------------------------ */

var aiUUID7Re = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// aiRequireDoctor mirrors middleware/role.middleware.ts `requireDoctor`,
// including its exact 403 message.
func (s *Server) aiRequireDoctor(next http.Handler) http.Handler {
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

// aiValidateAppointmentIDParam is `validate(appointmentIdParam)`: a
// `:appointmentId` that is not a UUIDv7 fails with the Zod envelope before any
// handler work happens.
func (s *Server) aiValidateAppointmentIDParam(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !aiUUID7Re.MatchString(chi.URLParam(r, "appointmentId")) {
			s.validationFail(w, "params.appointmentId", "Invalid id")
			return
		}
		next.ServeHTTP(w, r)
	})
}

/* ------------------------------------------------------------------ *
 * Request decoding, mirroring the Zod schemas and their message text
 * ------------------------------------------------------------------ */

// aiDecodeObjectBody reads the body as a JSON object. A missing or `null` body
// is `{}`, like the middleware's `req.body ?? {}`; any other JSON value is
// reported with the Zod type error the validate middleware would produce.
func aiDecodeObjectBody(r *http.Request) (map[string]any, string) {
	body := map[string]any{}
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	tok, err := dec.Token()
	if errors.Is(err, io.EOF) {
		return body, ""
	}
	if err != nil {
		return nil, "Validation Error"
	}
	if tok == nil {
		return body, ""
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, "Invalid input: expected object, received " + aiJSONType(tok)
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, "Validation Error"
		}
		key, _ := kt.(string)
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, "Validation Error"
		}
		body[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, "Validation Error"
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, "Validation Error"
	}
	return body, ""
}

func aiJSONType(v any) string {
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

// aiJSLen is the string length JavaScript would report (UTF-16 code units),
// which is what Zod's min/max and the controller's `.length` checks use.
func aiJSLen(s string) int {
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

// aiAppointmentIDField validates `appointmentId` against the shared uuid7
// schema: required string, UUIDv7, custom message "Invalid id" on format.
func aiAppointmentIDField(body map[string]any) (string, string, string) {
	v, exists := body["appointmentId"]
	if !exists {
		return "", "Invalid input: expected string, received undefined", "body.appointmentId"
	}
	if v == nil {
		return "", "Invalid input: expected string, received null", "body.appointmentId"
	}
	raw, ok := v.(string)
	if !ok {
		return "", "Invalid input: expected string, received " + aiJSONType(v), "body.appointmentId"
	}
	if !aiUUID7Re.MatchString(raw) {
		return "", "Invalid id", "body.appointmentId"
	}
	return raw, "", ""
}

// aiAnswer is one stored pre-session answer; the column is
// `JSON.stringify([{question, answer}, ...])`.
type aiAnswer struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// aiAnswersField validates the SubmitAnswersSchema array: 1..10 entries, each
// an object with non-empty `question` and `answer` strings. The schema is not
// `.strict()`, so unknown keys inside the entries are stripped, not rejected.
func aiAnswersField(body map[string]any) ([]aiAnswer, string, string) {
	v, exists := body["answers"]
	if !exists {
		return nil, "Invalid input: expected array, received undefined", "body.answers"
	}
	if v == nil {
		return nil, "Invalid input: expected array, received null", "body.answers"
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, "Invalid input: expected array, received " + aiJSONType(v), "body.answers"
	}
	answers := make([]aiAnswer, 0, len(arr))
	for i, el := range arr {
		obj, ok := el.(map[string]any)
		if !ok {
			return nil, "Invalid input: expected object, received " + aiJSONType(el), fmt.Sprintf("body.answers.%d", i)
		}
		question, msg := aiRequiredStringField(obj, "question", "Question is required")
		if msg != "" {
			return nil, msg, fmt.Sprintf("body.answers.%d.question", i)
		}
		answer, msg := aiRequiredStringField(obj, "answer", "Answer is required")
		if msg != "" {
			return nil, msg, fmt.Sprintf("body.answers.%d.answer", i)
		}
		answers = append(answers, aiAnswer{Question: question, Answer: answer})
	}
	if len(arr) < 1 {
		return nil, "At least one answer is required", "body.answers"
	}
	if len(arr) > 10 {
		return nil, "Too many answers", "body.answers"
	}
	return answers, "", ""
}

func aiRequiredStringField(obj map[string]any, key, requiredMsg string) (string, string) {
	v, exists := obj[key]
	if !exists {
		return "", "Invalid input: expected string, received undefined"
	}
	if v == nil {
		return "", "Invalid input: expected string, received null"
	}
	s, ok := v.(string)
	if !ok {
		return "", "Invalid input: expected string, received " + aiJSONType(v)
	}
	if aiJSLen(s) < 1 {
		return "", requiredMsg
	}
	return s, ""
}

// aiQueryField validates MatchDoctorsSchema's `query`: 3..300 characters.
func aiQueryField(body map[string]any) (string, string, string) {
	v, exists := body["query"]
	if !exists {
		return "", "Invalid input: expected string, received undefined", "body.query"
	}
	if v == nil {
		return "", "Invalid input: expected string, received null", "body.query"
	}
	s, ok := v.(string)
	if !ok {
		return "", "Invalid input: expected string, received " + aiJSONType(v), "body.query"
	}
	if aiJSLen(s) < 3 {
		return "", "Describe what you're looking for (min. 3 characters)", "body.query"
	}
	if aiJSLen(s) > 300 {
		return "", "Too big: expected string to have <=300 characters", "body.query"
	}
	return s, "", ""
}

/* ------------------------------------------------------------------ *
 * Controller error mapping
 * ------------------------------------------------------------------ */

// aiControllerFail mirrors the controllers' `publicMessageFor(error) ??
// {message, status}`: typed errors keep their own status and message, anything
// else (driver text, parsing) becomes the controller's fixed fallback and is
// never echoed to the client.
func (s *Server) aiControllerFail(w http.ResponseWriter, r *http.Request, err error, status int, message string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.FailExtra(w, appErr.Status, appErr.Message, appErr.Extra)
		return
	}
	if status >= http.StatusInternalServerError {
		s.Log.Error("ai handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	}
	s.Fail(w, status, message)
}

// aiParseJSON mirrors the service's parseJson: parse or fall back.
func aiParseJSON(raw *string, fallback any) any {
	if raw == nil {
		return fallback
	}
	var v any
	if err := json.Unmarshal([]byte(*raw), &v); err != nil {
		return fallback
	}
	return v
}

/* ------------------------------------------------------------------ *
 * Appointments and PreSessionData
 * ------------------------------------------------------------------ */

type aiAppointment struct {
	UserID          string
	Status          string
	DoctorSpecialty string
	DoctorUserID    string
	PatientName     *string
	Notes           *string
}

func (s *Server) aiLoadAppointment(ctx context.Context, appointmentID string) (*aiAppointment, error) {
	var a aiAppointment
	var (
		patientName sql.NullString
		notes       sql.NullString
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT a.userId, a.status, u.name, a.notes, d.specialty, d.userId "+
			"FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId "+
			"JOIN `User` u ON u.id = a.userId WHERE a.id = ?",
		appointmentID).Scan(&a.UserID, &a.Status, &patientName, &notes, &a.DoctorSpecialty, &a.DoctorUserID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if patientName.Valid {
		a.PatientName = &patientName.String
	}
	if notes.Valid {
		a.Notes = &notes.String
	}
	return &a, nil
}

type aiPreSessionRow struct {
	AppointmentID  string
	QuestionsJSON  *string
	AnswersJSON    *string
	BriefingText   *string
	BriefingSource *string
}

func (s *Server) aiLoadPreSession(ctx context.Context, appointmentID string) (*aiPreSessionRow, error) {
	var (
		row              aiPreSessionRow
		questions, ans   sql.NullString
		briefing, source sql.NullString
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT appointmentId, questionsJson, answersJson, briefingText, briefingSource "+
			"FROM `PreSessionData` WHERE appointmentId = ?",
		appointmentID).Scan(&row.AppointmentID, &questions, &ans, &briefing, &source)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if questions.Valid {
		row.QuestionsJSON = &questions.String
	}
	if ans.Valid {
		row.AnswersJSON = &ans.String
	}
	if briefing.Valid {
		row.BriefingText = &briefing.String
	}
	if source.Valid {
		row.BriefingSource = &source.String
	}
	return &row, nil
}

// aiParseAnswers reads the stored answersJson as the answer list; malformed or
// absent content reads as an empty list.
func aiParseAnswers(raw *string) []aiAnswer {
	out := []aiAnswer{}
	if raw == nil {
		return out
	}
	var parsed []aiAnswer
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return out
	}
	if parsed == nil {
		return out
	}
	return parsed
}

/* ------------------------------------------------------------------ *
 * POST /ai/pre-session
 * ------------------------------------------------------------------ */

func (s *Server) handleAIPreSessionQuestions(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, decodeErr := aiDecodeObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	appointmentID, path, msg := aiAppointmentIDField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}

	data, err := s.aiGetQuestionsForPatient(r.Context(), appointmentID, user.ID)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusBadRequest, "Failed to generate questions.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *Server) aiGetQuestionsForPatient(ctx context.Context, appointmentID, userID string) (map[string]any, error) {
	appointment, err := s.aiLoadAppointment(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	// assertPatient(appointment, userId, "confirmed").
	if appointment == nil || appointment.UserID != userID {
		return nil, NotFound("Appointment not found")
	}
	if appointment.Status != "confirmed" && appointment.Status != "completed" {
		return nil, BadRequest("Questions are only available for confirmed appointments")
	}

	existing, err := s.aiLoadPreSession(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.QuestionsJSON != nil && *existing.QuestionsJSON != "" {
		return map[string]any{
			"questions":        aiParseJSON(existing.QuestionsJSON, []any{}),
			"alreadyGenerated": true,
		}, nil
	}

	questions, source, reason := s.aiPreSessionQuestions(ctx, appointment.DoctorSpecialty, appointment.Notes)
	raw, err := json.Marshal(questions)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `PreSessionData` (`id`,`appointmentId`,`questionsJson`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?) AS `vals` "+
			"ON DUPLICATE KEY UPDATE `questionsJson`=`vals`.`questionsJson`, `updatedAt`=`vals`.`updatedAt`",
		newID(), appointmentID, string(raw), now, now); err != nil {
		return nil, err
	}

	return map[string]any{
		"questions":        questions,
		"alreadyGenerated": false,
		// The patient is answering these before they see them, so whether they
		// are personalised or a fixed set is worth stating.
		"ai": aiProvenance(source, reason),
	}, nil
}

/* ------------------------------------------------------------------ *
 * GET /ai/pre-session/:appointmentId
 * ------------------------------------------------------------------ */

func (s *Server) handleAIPreSessionData(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	appointmentID := chi.URLParam(r, "appointmentId")

	data, err := s.aiGetPreSessionDataJSON(r.Context(), appointmentID, user)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusBadRequest, "Failed to fetch pre-session data.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

// aiGetPreSessionDataJSON is PreSessionService.getData: the patient's own form
// or the assigned doctor's view, and nobody else's - not admins, and not a
// clinician who is not the appointment's doctor.
func (s *Server) aiGetPreSessionDataJSON(ctx context.Context, appointmentID string, user *UserCtx) (any, error) {
	appointment, err := s.aiLoadAppointment(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	if appointment == nil {
		return nil, NotFound("Appointment not found")
	}

	isPatient := appointment.UserID == user.ID
	isAssignedDoctor := user.Role == "doctor" && appointment.DoctorUserID == user.ID
	switch {
	case isPatient:
		if appointment.Status == "cancelled" {
			return nil, Forbidden("this appointment was cancelled")
		}
	case isAssignedDoctor:
		if appointment.Status == "pending" {
			return nil, Forbidden("pre-session data is available once the patient confirms")
		}
	default:
		return nil, Forbidden("not your appointment")
	}

	data, err := s.aiLoadPreSession(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, nil
	}

	questions := aiParseJSON(data.QuestionsJSON, []any{})
	answers := aiParseJSON(data.AnswersJSON, []any{})
	var briefingText any
	if isAssignedDoctor && data.BriefingText != nil {
		briefingText = *data.BriefingText
	}
	return map[string]any{
		"questions":    questions,
		"answers":      answers,
		"briefingText": briefingText,
	}, nil
}

/* ------------------------------------------------------------------ *
 * POST /ai/pre-session/answers
 * ------------------------------------------------------------------ */

func (s *Server) handleAIPreSessionAnswers(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, decodeErr := aiDecodeObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	appointmentID, path, msg := aiAppointmentIDField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}
	answers, path, msg := aiAnswersField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}

	if err := s.aiSubmitAnswers(r.Context(), appointmentID, user.ID, answers); err != nil {
		s.aiControllerFail(w, r, err, http.StatusBadRequest, "Failed to submit answers.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

func (s *Server) aiSubmitAnswers(ctx context.Context, appointmentID, userID string, answers []aiAnswer) error {
	appointment, err := s.aiLoadAppointment(ctx, appointmentID)
	if err != nil {
		return err
	}
	if appointment == nil || appointment.UserID != userID {
		return NotFound("Appointment not found")
	}
	if appointment.Status != "confirmed" && appointment.Status != "completed" {
		return BadRequest("Questions are only available for confirmed appointments")
	}

	data, err := s.aiLoadPreSession(ctx, appointmentID)
	if err != nil {
		return err
	}
	if data == nil || data.QuestionsJSON == nil || *data.QuestionsJSON == "" {
		return BadRequest("Pre-session questions have not been generated yet")
	}

	raw, err := json.Marshal(answers)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `PreSessionData` (`id`,`appointmentId`,`answersJson`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?) AS `vals` "+
			"ON DUPLICATE KEY UPDATE `answersJson`=`vals`.`answersJson`, `updatedAt`=`vals`.`updatedAt`",
		newID(), appointmentID, string(raw), now, now); err != nil {
		return err
	}

	// Invalidate any previously generated briefing. `briefingSource` is left
	// alone, exactly like the Node service: it is only meaningful alongside a
	// non-null briefingText, and the regeneration rewrites both together.
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `PreSessionData` SET `briefingText` = NULL, `updatedAt` = ? WHERE `appointmentId` = ?",
		time.Now().UTC(), appointmentID); err != nil {
		return err
	}
	return nil
}

/* ------------------------------------------------------------------ *
 * POST /ai/briefing and GET /ai/briefing/:appointmentId
 * ------------------------------------------------------------------ */

func (s *Server) handleAIBriefingGenerate(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, decodeErr := aiDecodeObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	appointmentID, path, msg := aiAppointmentIDField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}

	data, err := s.aiGetBriefing(r.Context(), appointmentID, user.ID)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusBadRequest, "Failed to generate briefing.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *Server) handleAIBriefingGet(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	appointmentID := chi.URLParam(r, "appointmentId")

	data, err := s.aiGetBriefing(r.Context(), appointmentID, user.ID)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusBadRequest, "Failed to fetch briefing.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *Server) aiGetBriefing(ctx context.Context, appointmentID, userID string) (map[string]any, error) {
	appointment, err := s.aiLoadAppointment(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	if appointment == nil {
		return nil, NotFound("Appointment not found")
	}
	if appointment.DoctorUserID != userID {
		return nil, Forbidden("briefing is restricted to the assigned doctor")
	}
	if appointment.Status == "pending" || appointment.Status == "cancelled" {
		return nil, Forbidden("no briefing is available for this appointment")
	}

	data, err := s.aiLoadPreSession(ctx, appointmentID)
	if err != nil {
		return nil, err
	}

	moodHistory, err := s.aiGetMoodHistory(ctx, appointment.UserID, 14)
	if err != nil {
		return nil, err
	}
	assessments, err := s.aiGetLatestAssessments(ctx, appointment.UserID)
	if err != nil {
		return nil, err
	}

	var result map[string]any
	cached := false
	if data != nil && data.BriefingText != nil && *data.BriefingText != "" {
		cached = true
		source := "model"
		if data.BriefingSource != nil {
			source = *data.BriefingSource
		}
		answers := aiParseAnswers(data.AnswersJSON)
		result = map[string]any{
			"briefing": *data.BriefingText,
			"cached":   true,
			// Read back from storage rather than re-derived, so a briefing
			// generated last week still reports its own origin.
			"ai":               map[string]any{"source": source},
			"moodHistory":      aiMoodHistoryJSON(moodHistory),
			"answers":          aiParseJSON(data.AnswersJSON, []any{}),
			"assessments":      aiAssessmentsJSON(assessments),
			"sources":          aiBuildCitations(moodHistory, answers, assessments, appointmentID),
			"insufficientData": aiInsufficientData(moodHistory, answers, assessments),
		}
	} else {
		var answersRaw *string
		if data != nil {
			answersRaw = data.AnswersJSON
		}
		answers := aiParseAnswers(answersRaw)
		briefingText, source, reason := s.aiDoctorBriefing(
			ctx, appointment.PatientName, appointment.DoctorSpecialty, moodHistory, answers, assessments)

		now := time.Now().UTC()
		if _, err := s.DB.ExecContext(ctx,
			"INSERT INTO `PreSessionData` (`id`,`appointmentId`,`briefingText`,`briefingSource`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?) AS `vals` "+
				"ON DUPLICATE KEY UPDATE `briefingText`=`vals`.`briefingText`, `briefingSource`=`vals`.`briefingSource`, `updatedAt`=`vals`.`updatedAt`",
			newID(), appointmentID, briefingText, source, now, now); err != nil {
			return nil, err
		}

		// The origin is persisted with the text, not just returned, because
		// this row is re-read later and a flag that lived only on this response
		// would be gone by the time a clinician opened the cached briefing.
		result = map[string]any{
			"briefing":         briefingText,
			"cached":           false,
			"ai":               aiProvenance(source, reason),
			"moodHistory":      aiMoodHistoryJSON(moodHistory),
			"answers":          answers,
			"assessments":      aiAssessmentsJSON(assessments),
			"sources":          aiBuildCitations(moodHistory, answers, assessments, appointmentID),
			"insufficientData": aiInsufficientData(moodHistory, answers, assessments),
		}
	}

	// A briefing is the richest clinical read in the application; the audit
	// records reads that actually happened, after the ownership and status
	// gates, and never throws.
	actor := userID
	targetType := "Briefing"
	via := "POST /api/ai/briefing"
	if cached {
		via = "GET /api/ai/briefing/:appointmentId"
	}
	s.audit(ctx, "clinical.read", &actor, &targetType, &appointmentID, map[string]any{
		"subjectId": appointment.UserID,
		"via":       via,
		"cached":    cached,
	})

	return result, nil
}

/* ------------------------------------------------------------------ *
 * POST /ai/copilot-draft
 * ------------------------------------------------------------------ */

// handleAICopilotDraft serves one ephemeral session-prep draft to the assigned
// clinician. It writes nothing except the audit row: drafts are generated,
// returned and forgotten, so there is no stale draft to misread later.
func (s *Server) handleAICopilotDraft(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, decodeErr := aiDecodeObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	appointmentID, path, msg := aiAppointmentIDField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}

	data, err := s.aiGetCopilotDraft(r.Context(), appointmentID, user.ID)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusBadRequest, "Failed to draft session prep.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

// aiGetCopilotDraft assembles the same inputs as the briefing but through an
// independent prompt that drafts prep bullets instead of a synthesis
// paragraph. The gate is deliberately the briefing's gate — assigned doctor,
// no pending or cancelled appointments — so a draft can never reach a wider
// audience than the briefing it is derived from.
func (s *Server) aiGetCopilotDraft(ctx context.Context, appointmentID, userID string) (map[string]any, error) {
	appointment, err := s.aiLoadAppointment(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	if appointment == nil {
		return nil, NotFound("Appointment not found")
	}
	if appointment.DoctorUserID != userID {
		return nil, Forbidden("session prep is restricted to the assigned doctor")
	}
	if appointment.Status == "pending" || appointment.Status == "cancelled" {
		return nil, Forbidden("no session prep is available for this appointment")
	}

	data, err := s.aiLoadPreSession(ctx, appointmentID)
	if err != nil {
		return nil, err
	}
	var answers []aiAnswer
	if data != nil {
		answers = aiParseAnswers(data.AnswersJSON)
	}
	moodHistory, err := s.aiGetMoodHistory(ctx, appointment.UserID, 14)
	if err != nil {
		return nil, err
	}
	assessments, err := s.aiGetLatestAssessments(ctx, appointment.UserID)
	if err != nil {
		return nil, err
	}

	draft, source, reason := s.aiCopilotDraft(
		ctx, appointment.PatientName, appointment.DoctorSpecialty, moodHistory, answers, assessments)

	actor := userID
	targetType := "CopilotDraft"
	s.audit(ctx, "clinical.read", &actor, &targetType, &appointmentID, map[string]any{
		"subjectId": appointment.UserID,
		"via":       "POST /api/ai/copilot-draft",
	})

	return map[string]any{
		"draft":            draft,
		"ai":               aiProvenance(source, reason),
		"sources":          aiBuildCitations(moodHistory, answers, assessments, appointmentID),
		"insufficientData": aiInsufficientData(moodHistory, answers, assessments),
	}, nil
}

/* ------------------------------------------------------------------ *
 * Wellness reads used by the AI surfaces (WellnessService.getMoodHistory
 * and getLatestAssessments)
 * ------------------------------------------------------------------ */

type aiMoodRow struct {
	ID        string
	Mood      int
	Notes     *string
	MoodDate  string
	CreatedAt time.Time
}

type aiAssessmentLite struct {
	ID        string
	Type      string
	Score     int
	Severity  string
	CreatedAt time.Time
}

func aiMoodHistoryJSON(entries []aiMoodRow) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"id":        e.ID,
			"mood":      e.Mood,
			"createdAt": jsTimeValue(e.CreatedAt),
			"moodDate":  e.MoodDate,
			"notes":     e.Notes,
		})
	}
	return out
}

func aiAssessmentsJSON(entries []aiAssessmentLite) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, a := range entries {
		out = append(out, map[string]any{
			"id":        a.ID,
			"type":      a.Type,
			"score":     a.Score,
			"severity":  a.Severity,
			"createdAt": jsTimeValue(a.CreatedAt),
		})
	}
	return out
}

func (s *Server) aiGetMoodHistory(ctx context.Context, userID string, days int) ([]aiMoodRow, error) {
	tz := s.aiUserTimezone(ctx, userID)
	since := aiStartOfZonedDay(aiShiftDayKey(aiTodayKey(tz), -days, tz), tz)

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, mood, notes, moodDate, createdAt FROM `MoodEntry` "+
			"WHERE userId = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT ?",
		userID, since, max(days, 1)*2)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := make([]aiMoodRow, 0)
	for rows.Next() {
		var (
			row   aiMoodRow
			notes sql.NullString
		)
		if err := rows.Scan(&row.ID, &row.Mood, &notes, &row.MoodDate, &row.CreatedAt); err != nil {
			return nil, err
		}
		if notes.Valid {
			row.Notes = &notes.String
		}
		entries = append(entries, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *Server) aiGetLatestAssessments(ctx context.Context, userID string) ([]aiAssessmentLite, error) {
	// `[phq9, gad7].filter(Boolean)` - the instrument order is the payload's.
	out := make([]aiAssessmentLite, 0, 2)
	for _, assessmentType := range []string{"phq9", "gad7"} {
		var row aiAssessmentLite
		err := s.DB.QueryRowContext(ctx,
			"SELECT id, type, score, severity, createdAt FROM `Assessment` "+
				"WHERE userId = ? AND type = ? ORDER BY createdAt DESC LIMIT 1",
			userID, assessmentType).Scan(&row.ID, &row.Type, &row.Score, &row.Severity, &row.CreatedAt)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}

/* ------------------------------------------------------------------ *
 * Timezone-aware day helpers (lib/date.ts, as used by getMoodHistory)
 * ------------------------------------------------------------------ */

var aiTZCache sync.Map

func aiLocation(tz string) *time.Location {
	if cached, ok := aiTZCache.Load(tz); ok {
		return cached.(*time.Location)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.FixedZone("WIB", 7*60*60)
	}
	aiTZCache.Store(tz, loc)
	return loc
}

func aiResolveTimezone(tz *string) string {
	if tz == nil || *tz == "" {
		return "Asia/Jakarta"
	}
	if _, err := time.LoadLocation(*tz); err != nil {
		return "Asia/Jakarta"
	}
	return *tz
}

func aiZoneOffset(at time.Time, tz string) time.Duration {
	wall := at.In(aiLocation(tz))
	asUTC := time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), 0, time.UTC)
	return asUTC.Sub(at.UTC())
}

func aiStartOfZonedDay(key, tz string) time.Time {
	base, err := time.ParseInLocation("2006-01-02", key, time.UTC)
	if err != nil {
		return time.Now().UTC()
	}
	guess := base
	for i := 0; i < 2; i++ {
		guess = base.Add(-aiZoneOffset(guess, tz))
	}
	return guess
}

func aiDayKey(at time.Time, tz string) string {
	return at.In(aiLocation(tz)).Format("2006-01-02")
}

func aiShiftDayKey(key string, count int, tz string) string {
	base := aiStartOfZonedDay(key, tz)
	shifted := base.Add(time.Duration(count)*24*time.Hour + aiZoneOffset(base, tz))
	return aiDayKey(shifted, tz)
}

func aiTodayKey(tz string) string {
	return aiDayKey(time.Now().UTC(), tz)
}

func (s *Server) aiUserTimezone(ctx context.Context, userID string) string {
	var tz *string
	if err := s.DB.QueryRowContext(ctx, "SELECT timezone FROM `User` WHERE id = ?", userID).Scan(&tz); err != nil {
		return "Asia/Jakarta"
	}
	return aiResolveTimezone(tz)
}

/* ------------------------------------------------------------------ *
 * POST /ai/resources
 * ------------------------------------------------------------------ */

func (s *Server) handleAIResources(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)

	moodHistory, err := s.aiGetMoodHistory(r.Context(), user.ID, 14)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusInternalServerError, "Failed to get suggestions.")
		return
	}
	data, source, reason := s.aiSuggestResources(r.Context(), moodHistory)

	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data":   data,
		// The UI shows a "standard guidance" state for the fallback list, so
		// nobody mistakes a template for a personal suggestion.
		"ai": aiProvenance(source, reason),
	})
}

/* ------------------------------------------------------------------ *
 * POST /ai/match-doctors
 * ------------------------------------------------------------------ */

// aiSpecialtyHints is the controller's fallback keyword → specialty table, in
// order: the first match wins.
var aiSpecialtyHints = []struct {
	keywords  *regexp.Regexp
	specialty string
}{
	{regexp.MustCompile(`(?i)(anxiet|cemas|panic|kecemasan)`), "Clinical"},
	{regexp.MustCompile(`(?i)(depress|depresi|hopeless)`), "Clinical"},
	{regexp.MustCompile(`(?i)(trauma|ptsd|abuse|kekerasan)`), "Trauma"},
	{regexp.MustCompile(`(?i)(addict|kecanduan|narkoba|alcohol|alkohol)`), "Addiction"},
	{regexp.MustCompile(`(?i)(marri|pasangan|relationship|rumah tangga)`), "Family"},
	{regexp.MustCompile(`(?i)(child|anak|teen|remaja)`), "Family"},
	{regexp.MustCompile(`(?i)(career|karier|work|kerja|burnout)`), "Clinical"},
}

func aiSpecialtyHint(query string) (string, bool) {
	for _, hint := range aiSpecialtyHints {
		if hint.keywords.MatchString(query) {
			return hint.specialty, true
		}
	}
	return "", false
}

// aiKeywordFallback is `query.split(/\s+/).filter(w => w.length > 3).slice(0, 6)`.
func aiKeywordFallback(query string) []string {
	out := []string{}
	for _, w := range strings.Fields(query) {
		if aiJSLen(w) > 3 {
			out = append(out, w)
			if len(out) == 6 {
				break
			}
		}
	}
	return out
}

type aiMatchCriteria struct {
	Specialty     *string
	MaxPrice      *float64
	MinExperience *float64
	Keywords      []string
}

type aiDoctorMatch struct {
	ID          string
	Specialty   string
	Experience  int
	Price       int
	Rating      float64
	Name        *string
	Avatar      *string
	ReviewCount int
}

func (s *Server) handleAIMatchDoctors(w http.ResponseWriter, r *http.Request) {
	body, decodeErr := aiDecodeObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	query, path, msg := aiQueryField(body)
	if msg != "" {
		s.validationFail(w, path, msg)
		return
	}

	// The controller trims and re-checks after validation.
	trimmed := strings.TrimSpace(query)
	if aiJSLen(trimmed) < 3 {
		s.Fail(w, http.StatusBadRequest, "Describe what you're looking for (min. 3 characters)")
		return
	}

	data, err := s.aiMatchDoctors(r.Context(), trimmed)
	if err != nil {
		s.aiControllerFail(w, r, err, http.StatusInternalServerError, "Failed to match doctors.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *Server) aiMatchDoctors(ctx context.Context, query string) (map[string]any, error) {
	criteria, source, reason := s.aiExtractMatchCriteria(ctx, query)
	if len(criteria.Keywords) == 0 {
		criteria.Keywords = aiKeywordFallback(query)
	}

	sqlText := "SELECT d.id, d.specialty, d.experience, d.price, d.rating, u.name, u.avatar, " +
		"(SELECT COUNT(*) FROM `Review` r WHERE r.doctorId = d.id) " +
		"FROM `Doctor` d JOIN `User` u ON u.id = d.userId " +
		"WHERE d.verificationStatus = 'approved'"
	args := []any{}
	if criteria.Specialty != nil {
		sqlText += " AND d.specialty LIKE ?"
		args = append(args, "%"+*criteria.Specialty+"%")
	}
	if criteria.MinExperience != nil {
		sqlText += " AND d.experience >= ?"
		args = append(args, int(*criteria.MinExperience))
	}
	if criteria.MaxPrice != nil {
		sqlText += " AND d.price <= ?"
		args = append(args, int(*criteria.MaxPrice))
	}
	sqlText += " ORDER BY d.rating DESC LIMIT 5"

	rows, err := s.DB.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	doctors := make([]aiDoctorMatch, 0, 5)
	for rows.Next() {
		var (
			m      aiDoctorMatch
			name   sql.NullString
			avatar sql.NullString
		)
		if err := rows.Scan(&m.ID, &m.Specialty, &m.Experience, &m.Price, &m.Rating, &name, &avatar, &m.ReviewCount); err != nil {
			return nil, err
		}
		if name.Valid {
			m.Name = &name.String
		}
		if avatar.Valid {
			m.Avatar = &avatar.String
		}
		doctors = append(doctors, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Rank: prefer the specialty match, then rating (the SQL already sorted by
	// rating). `matchReasons` states only what actually drove the match, so
	// every reason is verifiable against the row.
	matched := make([]map[string]any, 0, len(doctors))
	for _, d := range doctors {
		if criteria.Specialty != nil && !strings.Contains(strings.ToLower(d.Specialty), strings.ToLower(*criteria.Specialty)) {
			continue
		}
		name := "Doctor"
		if d.Name != nil && *d.Name != "" {
			name = *d.Name
		}
		reasons := aiBuildMatchReasons(d, criteria.Specialty)
		matched = append(matched, map[string]any{
			"id":           d.ID,
			"name":         name,
			"avatar":       d.Avatar,
			"specialty":    d.Specialty,
			"rating":       d.Rating,
			"price":        d.Price,
			"experience":   d.Experience,
			"reviewCount":  d.ReviewCount,
			"matchReasons": reasons,
		})
	}

	var specialtyOut any
	if criteria.Specialty != nil {
		specialtyOut = *criteria.Specialty
	}
	var maxPriceOut, minExperienceOut any
	if criteria.MaxPrice != nil {
		maxPriceOut = *criteria.MaxPrice
	}
	if criteria.MinExperience != nil {
		minExperienceOut = *criteria.MinExperience
	}

	return map[string]any{
		"query": query,
		"criteria": map[string]any{
			"specialty":     specialtyOut,
			"maxPrice":      maxPriceOut,
			"minExperience": minExperienceOut,
		},
		"doctors": matched,
		// Provenance, not `aiPowered: !!apiKey` - this reports whether a model
		// was actually consulted.
		"ai": aiProvenance(source, reason),
	}, nil
}

func aiBuildMatchReasons(doctor aiDoctorMatch, criteriaSpecialty *string) []string {
	reasons := []string{}
	if criteriaSpecialty != nil && strings.Contains(strings.ToLower(doctor.Specialty), strings.ToLower(*criteriaSpecialty)) {
		reasons = append(reasons, "Specialises in "+doctor.Specialty)
	}
	if doctor.ReviewCount > 0 {
		plural := "reviews"
		if doctor.ReviewCount == 1 {
			plural = "review"
		}
		reasons = append(reasons, fmt.Sprintf("%s from %d %s", aiToFixed1(doctor.Rating), doctor.ReviewCount, plural))
	}
	if doctor.Experience > 0 {
		plural := "years"
		if doctor.Experience == 1 {
			plural = "year"
		}
		reasons = append(reasons, fmt.Sprintf("%d %s of experience", doctor.Experience, plural))
	}
	return reasons
}

/* ------------------------------------------------------------------ *
 * Deterministic fallback text (ai.service.ts degraded branches)
 * ------------------------------------------------------------------ */

// aiBuildFallbackBriefing is generateDoctorBriefing's degraded paragraph,
// assembled locally. It says what it is and quotes nothing: a clinician must
// not read a template as a synthesis.
func aiBuildFallbackBriefing(moodHistory []aiMoodRow, answers []aiAnswer, assessments []aiAssessmentLite) string {
	avg := "n/a"
	if len(moodHistory) > 0 {
		sum := 0
		for _, m := range moodHistory {
			sum += m.Mood
		}
		avg = aiToFixed1(float64(sum) / float64(len(moodHistory)))
	}

	screening := ""
	if len(assessments) > 0 {
		parts := make([]string, 0, len(assessments))
		for _, a := range assessments {
			parts = append(parts, fmt.Sprintf("%s %d/%s (%s)",
				strings.ToUpper(a.Type), a.Score, aiMaxForAssessment(a.Type), a.Severity))
		}
		screening = " Latest screening: " + strings.Join(parts, ", ") + "."
	}

	concerns := ""
	for _, a := range answers {
		if concerns != "" {
			concerns += " "
		}
		concerns += a.Answer
	}
	concerns = strings.TrimSpace(concerns)

	concernClause := " "
	if concerns != "" {
		plural := "topics"
		if len(answers) == 1 {
			plural = "topic"
		}
		concernClause = fmt.Sprintf(" The patient raised %d %s during pre-session; the full responses are attached. ",
			len(answers), plural)
	}

	return "[Automated summary — written by the platform, not by a clinician] " +
		fmt.Sprintf("The patient has logged %d mood entries in the past 14 days with an average of %s/5.", len(moodHistory), avg) +
		screening +
		concernClause +
		"Consider exploring sleep quality, stress triggers, and coping strategies."
}

// aiMaxForAssessment is the instrument's own maximum, so a clinician reads a
// real denominator: PHQ-9 is out of 27 and GAD-7 out of 21.
func aiMaxForAssessment(assessmentType string) string {
	if strings.ToLower(assessmentType) == "gad7" {
		return "21"
	}
	return "27"
}

// aiToFixed1 is JavaScript's `Number#toFixed(1)`: round the exact binary
// value of x to one decimal, resolving ties towards the larger digit. A plain
// Go format rounds ties to even (2.25 -> "2.2" where JS says "2.3"), and
// multiplying by 10 first reintroduces binary rounding of its own (1.15 -> "1.2"
// where JS says "1.1"), so the arithmetic is done on the exact rational value.
func aiToFixed1(x float64) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return fmt.Sprintf("%v", x)
	}
	r := new(big.Rat).SetFloat64(x)
	r.Mul(r, big.NewRat(10, 1))
	r.Add(r, big.NewRat(1, 2))
	q := new(big.Int).Quo(r.Num(), r.Denom())
	if r.Num().Sign() < 0 && new(big.Int).Rem(r.Num(), r.Denom()).Sign() != 0 {
		q.Sub(q, big.NewInt(1))
	}
	neg := q.Sign() < 0
	abs := new(big.Int).Abs(q)
	whole := new(big.Int).Quo(abs, big.NewInt(10))
	frac := new(big.Int).Rem(abs, big.NewInt(10))
	out := whole.String() + "." + frac.String()
	if neg {
		return "-" + out
	}
	return out
}
