package server

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Between-session care: alliance feedback, consent ledger and caseload.
//
// SessionFeedback is the 4-item Session Rating Scale (listening, goals,
// approach, overall), each 0-10, one row per completed appointment. It is a
// patient report about the alliance, not a rating of the clinician, so it
// lives apart from Review and never touches Doctor.rating.
//
// Consent is per-purpose opt-in. ai-read gates whether the patient's
// pre-session answers may be sent to a model; data-share records whether the
// patient allows anonymised use. One row per (user, purpose), updated not
// deleted, audited like every clinical write.
//
// Caseload is the clinician's morning view: who they treat, what is overdue,
// and which safety plans have not been jointly reviewed. No new table, only
// the queries the dashboard already needs.

func (s *Server) registerBetween(api chi.Router) {
	api.With(s.authenticate).Get("/account/consents", s.handleConsentList)
	api.With(s.authenticate).Put("/account/consents", s.handleConsentSet)
	api.With(s.authenticate).Post("/appointments/{id}/feedback", s.handleFeedbackCreate)
	api.With(s.authenticate).Get("/appointments/{id}/feedback", s.handleFeedbackGet)
	api.With(s.authenticate, s.RequireRole("doctor", "admin")).Get("/doctors/caseload", s.handleCaseload)
}

var betweenConsentPurposes = []string{"ai-read", "data-share"}

func (s *Server) handleConsentList(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT purpose, granted, grantedAt, revokedAt FROM `Consent` WHERE userId = ?", user.ID)
	if err != nil {
		s.Fail(w, http.StatusInternalServerError, "Failed to load consents.")
		return
	}
	defer rows.Close()
	out := map[string]any{}
	for _, p := range betweenConsentPurposes {
		out[p] = map[string]any{"granted": false, "grantedAt": nil, "revokedAt": nil}
	}
	for rows.Next() {
		var purpose string
		var granted bool
		var grantedAt, revokedAt *time.Time
		if err := rows.Scan(&purpose, &granted, &grantedAt, &revokedAt); err != nil {
			continue
		}
		out[purpose] = map[string]any{"granted": granted, "grantedAt": jsTime(grantedAt), "revokedAt": jsTime(revokedAt)}
	}
	// AI read consent also mirrors the User flag for fast checks without a join.
	var aiFlag bool
	_ = s.DB.QueryRowContext(r.Context(), "SELECT aiReadConsent FROM `User` WHERE id = ?", user.ID).Scan(&aiFlag)
	out["aiReadConsentFlag"] = aiFlag
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": out})
}

func (s *Server) handleConsentSet(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	rawPurpose, _ := body["purpose"].(string)
	if !containsString(betweenConsentPurposes, rawPurpose) {
		s.validationFail(w, "body.purpose", "Invalid option: expected one of \"ai-read\"|\"data-share\"")
		return
	}
	grantedRaw, present := body["granted"]
	if !present {
		s.validationFail(w, "body.granted", "Invalid input: expected boolean, received undefined")
		return
	}
	granted, ok := grantedRaw.(bool)
	if !ok {
		s.validationFail(w, "body.granted", "Invalid input: expected boolean, received "+careJSONType(grantedRaw))
		return
	}
	if msg := careUnknownKeys(keys, "purpose", "granted"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}
	now := time.Now().UTC()
	var existingID string
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT id FROM `Consent` WHERE userId = ? AND purpose = ?", user.ID, rawPurpose).Scan(&existingID)
	if err != nil && err != sql.ErrNoRows {
		s.Fail(w, http.StatusBadRequest, "Failed to save consent.")
		return
	}
	if err == sql.ErrNoRows {
		var grantedAt, revokedAt any
		if granted {
			grantedAt = now
		} else {
			revokedAt = now
		}
		if _, err := s.DB.ExecContext(r.Context(),
			"INSERT INTO `Consent` (id, userId, purpose, granted, grantedAt, revokedAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)",
			newID(), user.ID, rawPurpose, granted, grantedAt, revokedAt, now, now); err != nil {
			s.Log.Error("consent insert failed", "err", err)
			s.Fail(w, http.StatusBadRequest, "Failed to save consent.")
			return
		}
	} else {
		if granted {
			_, err = s.DB.ExecContext(r.Context(),
				"UPDATE `Consent` SET granted = ?, grantedAt = ?, revokedAt = NULL, updatedAt = ? WHERE id = ?",
				true, now, now, existingID)
		} else {
			_, err = s.DB.ExecContext(r.Context(),
				"UPDATE `Consent` SET granted = ?, revokedAt = ?, updatedAt = ? WHERE id = ?",
				false, now, now, existingID)
		}
		if err != nil {
			s.Log.Error("consent update failed", "err", err)
			s.Fail(w, http.StatusBadRequest, "Failed to save consent.")
			return
		}
	}
	if rawPurpose == "ai-read" {
		_, _ = s.DB.ExecContext(r.Context(), "UPDATE `User` SET aiReadConsent = ?, updatedAt = ? WHERE id = ?", granted, now, user.ID)
	}
	target := "Consent"
	s.audit(r.Context(), "consent.updated", &user.ID, &target, nil, map[string]any{"purpose": rawPurpose, "granted": granted})
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"purpose": rawPurpose, "granted": granted}})
}

func (s *Server) handleFeedbackCreate(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	apptID := chi.URLParam(r, "id")
	if !careUUID7Pattern.MatchString(apptID) {
		s.validationFail(w, "params.id", "Invalid id")
		return
	}
	var apptUser, apptDoctor, status string
	if err := s.DB.QueryRowContext(r.Context(),
		"SELECT userId, doctorId, status FROM `Appointment` WHERE id = ?", apptID).Scan(&apptUser, &apptDoctor, &status); err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Appointment not found")
		return
	} else if err != nil {
		s.Fail(w, http.StatusBadRequest, "Failed to save feedback.")
		return
	}
	if apptUser != user.ID {
		s.Fail(w, http.StatusForbidden, "not your appointment")
		return
	}
	if status != "completed" {
		s.Fail(w, http.StatusBadRequest, "Feedback is for completed sessions only")
		return
	}
	body, keys, problem := careObjectBody(r)
	if problem != "" {
		s.validationFail(w, "body", problem)
		return
	}
	scores := map[string]int{}
	for _, k := range []string{"listening", "goals", "approach", "overall"} {
		v, present := body[k]
		if !present {
			s.validationFail(w, "body."+k, "Invalid input: expected number, received undefined")
			return
		}
		iv, msg := careIntValue(v, 0, "Score must be an integer 0-10")
		if msg != "" || iv > 10 {
			s.validationFail(w, "body."+k, "Score must be an integer 0-10")
			return
		}
		scores[k] = iv
	}
	var comment *string
	if v, present := body["comment"]; present && v != nil {
		str, ok := v.(string)
		if !ok {
			s.validationFail(w, "body.comment", "Invalid input: expected string, received "+careJSONType(v))
			return
		}
		if careJSLen(str) > 2000 {
			s.validationFail(w, "body.comment", careSection2000Msg)
			return
		}
		if strings.TrimSpace(str) != "" {
			c := s.careSanitizeText(str)
			comment = &c
		}
	}
	if msg := careUnknownKeys(keys, "listening", "goals", "approach", "overall", "comment"); msg != "" {
		s.validationFail(w, "body", msg)
		return
	}
	var existing int
	if err := s.DB.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM `SessionFeedback` WHERE appointmentId = ?", apptID).Scan(&existing); err == nil && existing > 0 {
		s.Fail(w, http.StatusConflict, "Feedback already recorded for this session")
		return
	}
	now := time.Now().UTC()
	fid := newID()
	if _, err := s.DB.ExecContext(r.Context(),
		"INSERT INTO `SessionFeedback` (id, appointmentId, userId, doctorId, listening, goals, approach, overall, comment, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
		fid, apptID, user.ID, apptDoctor, scores["listening"], scores["goals"], scores["approach"], scores["overall"], nullableString(comment), now); err != nil {
		if isDuplicateKey(err) {
			s.Fail(w, http.StatusConflict, "Feedback already recorded for this session")
			return
		}
		s.Log.Error("feedback insert failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to save feedback.")
		return
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{
		"appointmentId": apptID, "listening": scores["listening"], "goals": scores["goals"], "approach": scores["approach"], "overall": scores["overall"], "comment": comment,
	}})
}

func (s *Server) handleFeedbackGet(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	apptID := chi.URLParam(r, "id")
	if !careUUID7Pattern.MatchString(apptID) {
		s.validationFail(w, "params.id", "Invalid id")
		return
	}
	var apptUser, doctorUser string
	var doctorID string
	if err := s.DB.QueryRowContext(r.Context(),
		"SELECT ap.userId, d.userId, ap.doctorId FROM `Appointment` ap JOIN `Doctor` d ON d.id = ap.doctorId WHERE ap.id = ?", apptID).Scan(&apptUser, &doctorUser, &doctorID); err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Appointment not found")
		return
	} else if err != nil {
		s.Fail(w, http.StatusBadRequest, "Failed to load feedback.")
		return
	}
	if user.ID != apptUser && user.ID != doctorUser && user.Role != "admin" {
		s.Fail(w, http.StatusForbidden, "not your appointment")
		return
	}
	var (
		listening, goals, approach, overall int
		comment                              sql.NullString
		createdAt                            time.Time
	)
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT listening, goals, approach, overall, comment, createdAt FROM `SessionFeedback` WHERE appointmentId = ?", apptID).
		Scan(&listening, &goals, &approach, &overall, &comment, &createdAt)
	if err == sql.ErrNoRows {
		s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": nil})
		return
	}
	if err != nil {
		s.Fail(w, http.StatusBadRequest, "Failed to load feedback.")
		return
	}
	var c *string
	if comment.Valid {
		c = &comment.String
	}
	_ = doctorID
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"appointmentId": apptID, "listening": listening, "goals": goals, "approach": approach, "overall": overall, "comment": c, "createdAt": jsTimeValue(createdAt),
	}})
}

func (s *Server) handleCaseload(w http.ResponseWriter, r *http.Request) {
	doctor := CurrentUser(r)
	var doctorID string
	if err := s.DB.QueryRowContext(r.Context(), "SELECT id FROM `Doctor` WHERE userId = ?", doctor.ID).Scan(&doctorID); err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Doctor profile not found")
		return
	} else if err != nil {
		s.Fail(w, http.StatusInternalServerError, "Failed to load caseload.")
		return
	}
	ctx := r.Context()
	// My patients: distinct users with a live relationship.
	rows, err := s.DB.QueryContext(ctx,
		"SELECT DISTINCT u.id, u.name, u.email FROM `User` u JOIN `Appointment` ap ON ap.userId = u.id "+
			"WHERE ap.doctorId = ? AND ap.status IN ('confirmed','completed') ORDER BY u.name ASC LIMIT 200", doctorID)
	if err != nil {
		s.Fail(w, http.StatusInternalServerError, "Failed to load caseload.")
		return
	}
	defer rows.Close()
	patients := []map[string]any{}
	patientIDs := []string{}
	for rows.Next() {
		var id string
		var name, email sql.NullString
		if err := rows.Scan(&id, &name, &email); err != nil {
			continue
		}
		var n, e any
		if name.Valid {
			n = name.String
		}
		if email.Valid {
			e = email.String
		}
		patients = append(patients, map[string]any{"id": id, "name": n, "email": e})
		patientIDs = append(patientIDs, id)
	}
	// Upcoming confirmed sessions.
	upRows, err := s.DB.QueryContext(ctx,
		"SELECT id, userId, appointmentDate, startTime FROM `Appointment` WHERE doctorId = ? AND status = 'confirmed' AND appointmentDate >= CURDATE() ORDER BY appointmentDate ASC LIMIT 50", doctorID)
	if err == nil {
		defer upRows.Close()
	} else {
		upRows = nil
	}
	_ = upRows
	upcoming := []map[string]any{}
	if upRows != nil {
		for upRows.Next() {
			var id, uid string
			var dt time.Time
			var st sql.NullString
			if err := upRows.Scan(&id, &uid, &dt, &st); err != nil {
				continue
			}
			var start any
			if st.Valid {
				start = st.String
			}
			upcoming = append(upcoming, map[string]any{"id": id, "patientId": uid, "date": jsTimeValue(dt), "startTime": start})
		}
	}
	// Overdue risk: unresolved assigned to me and past SLA.
	riskRows, err := s.DB.QueryContext(ctx,
		"SELECT id, userId, level, createdAt, acknowledgedAt FROM `RiskAlert` WHERE assignedDoctorUserId = ? AND resolvedAt IS NULL ORDER BY createdAt ASC LIMIT 100", doctor.ID)
	overdue := []map[string]any{}
	if err == nil {
		defer riskRows.Close()
		for riskRows.Next() {
			var id, uid, level string
			var created time.Time
			var acked *time.Time
			if err := riskRows.Scan(&id, &uid, &level, &created, &acked); err != nil {
				continue
			}
			ackBy, resolveBy := wellnessRiskDeadlines(level)
			over := false
			if acked == nil {
				over = time.Since(created) > ackBy
			} else {
				over = time.Since(created) > resolveBy
			}
			if over {
				overdue = append(overdue, map[string]any{"id": id, "patientId": uid, "level": level, "createdAt": jsTimeValue(created)})
			}
		}
	}
	// Safety plans not jointly reviewed in 90 days, for my patients.
	unreviewed := []map[string]any{}
	if len(patientIDs) > 0 {
		place := strings.Repeat("?,", len(patientIDs))
		place = place[:len(place)-1]
		args := make([]any, len(patientIDs))
		for i, id := range patientIDs {
			args[i] = id
		}
		srRows, err := s.DB.QueryContext(ctx,
			"SELECT userId, lastReviewedAt FROM `SafetyPlan` WHERE userId IN ("+place+")", args...)
		if err == nil {
			defer srRows.Close()
			for srRows.Next() {
				var uid string
				var lr *time.Time
				if err := srRows.Scan(&uid, &lr); err != nil {
					continue
				}
				if lr == nil || time.Since(*lr) > 90*24*time.Hour {
					unreviewed = append(unreviewed, map[string]any{"patientId": uid, "lastReviewedAt": jsTime(lr)})
				}
			}
		}
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"patients":            patients,
		"upcoming":            upcoming,
		"overdueRisk":         overdue,
		"unreviewedSafety":    unreviewed,
		"counts":              map[string]any{"patients": len(patients), "upcoming": len(upcoming), "overdueRisk": len(overdue), "unreviewedSafety": len(unreviewed)},
		"overdueHomework":     []any{},
	}})
}

func isDuplicateKey(err error) bool {
	return jobsIsDuplicateKey(err)
}
