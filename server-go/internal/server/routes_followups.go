package server

import (
	"context"
	"database/sql"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// registerFollowUps is the port of server/src/routes/followUp.routes.ts.
func (s *Server) registerFollowUps(api chi.Router) {
	api.Group(func(api chi.Router) {
		api.Use(s.authenticate)
		api.Post("/appointments/{id}/follow-up", s.handleFollowUpSuggest)
		api.Get("/appointments/{id}/follow-up", s.handleFollowUpGet)
		api.Post("/follow-ups/{id}/accept", s.handleFollowUpAccept)
		api.Post("/follow-ups/{id}/decline", s.handleFollowUpDecline)
	})
}

/* ------------------------------------------------------------------ *
 * POST /appointments/:id/follow-up (SuggestFollowUpSchema)
 * ------------------------------------------------------------------ */

type followUpSuggestBody struct {
	SuggestedDate    string  `json:"suggestedDate"`
	StartTime        string  `json:"startTime"`
	EndTime          string  `json:"endTime"`
	ConsultationType *string `json:"consultationType"`
	Notes            *string `json:"notes"`
}

func (s *Server) handleFollowUpSuggest(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !apptUUID7OK(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return
	}
	var body followUpSuggestBody
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if msg := apptISODayError(body.SuggestedDate, "Suggested date"); msg != "" {
		s.validationFail(w, "body.suggestedDate", msg)
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
	if body.Notes != nil && len([]rune(*body.Notes)) > 1000 {
		s.validationFail(w, "body.notes", "Too big: expected string to have <=1000 characters")
		return
	}

	actor := CurrentUser(r)
	row, patientID, err := s.followUpSuggest(r.Context(), id, actor.ID, &body)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to suggest follow-up.")
		return
	}

	// The service notifies the patient after the suggestion exists.
	s.apptNotify(r.Context(), patientID, "Your doctor suggested a follow-up",
		"Dr. suggested a follow-up session on "+apptFormatGB(row.SuggestedDate)+" at "+row.StartTime+". Accept or decline from your appointments.",
		"appointment")

	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": row.JSON()})
}

func (s *Server) followUpSuggest(ctx context.Context, appointmentID, doctorUserID string, body *followUpSuggestBody) (*followUpRow, string, error) {
	var (
		apptDoctorID   string
		patientID      string
		assignedDoctor string
		status         string
		apptType       string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT a.doctorId, a.userId, d.userId, a.status, a.consultationType "+
			"FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId WHERE a.id = ?", appointmentID).
		Scan(&apptDoctorID, &patientID, &assignedDoctor, &status, &apptType)
	if err == sql.ErrNoRows {
		return nil, "", NotFound("Appointment not found")
	}
	if err != nil {
		return nil, "", err
	}
	if assignedDoctor != doctorUserID {
		return nil, "", Forbidden("only the assigned doctor can suggest a follow-up")
	}
	if status != "completed" {
		return nil, "", BadRequest("Follow-ups can only be suggested for completed sessions")
	}

	var existing int
	err = s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `FollowUp` WHERE appointmentId = ?", appointmentID).Scan(&existing)
	if err != nil {
		return nil, "", err
	}
	if existing > 0 {
		return nil, "", Conflict("A follow-up suggestion already exists for this appointment")
	}

	date := apptParseLocalDate(body.SuggestedDate)
	if date.IsZero() {
		return nil, "", BadRequest("Invalid date")
	}

	consultationType := apptType
	if body.ConsultationType != nil {
		consultationType = *body.ConsultationType
	}
	var notes *string
	if body.Notes != nil {
		clean := s.apptSanitizeClip(*body.Notes, 1000)
		notes = &clean
	}

	id := newID()
	now := time.Now().UTC()
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `FollowUp` (id, appointmentId, doctorId, suggestedDate, startTime, endTime, consultationType, notes, status, createdAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?)",
		id, appointmentID, apptDoctorID, date, body.StartTime, body.EndTime, consultationType, notes, "pending", now)
	if err != nil {
		return nil, "", err
	}

	row, err := scanFollowUpRow(s.DB.QueryRowContext(ctx, "SELECT "+followUpColumns+" FROM `FollowUp` WHERE id = ?", id))
	if err != nil {
		return nil, "", err
	}
	return row, patientID, nil
}

/* ------------------------------------------------------------------ *
 * GET /appointments/:id/follow-up
 * ------------------------------------------------------------------ */

func (s *Server) handleFollowUpGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		s.Fail(w, http.StatusBadRequest, "Invalid appointment id")
		return
	}
	actor := CurrentUser(r)

	var patientID, doctorUserID string
	err := s.DB.QueryRowContext(r.Context(),
		"SELECT a.userId, d.userId FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId WHERE a.id = ?", id).
		Scan(&patientID, &doctorUserID)
	if err == sql.ErrNoRows {
		s.apptControllerErr(w, r, NotFound("Appointment not found"), http.StatusInternalServerError, "Failed to fetch follow-up.")
		return
	}
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch follow-up.")
		return
	}
	isParticipant := patientID == actor.ID || (actor.Role == "doctor" && doctorUserID == actor.ID)
	if !isParticipant {
		s.apptControllerErr(w, r, Forbidden("not a participant"), http.StatusInternalServerError, "Failed to fetch follow-up.")
		return
	}

	followUp, err := s.apptFollowUpJSON(r.Context(), id)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch follow-up.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": followUp})
}

/* ------------------------------------------------------------------ *
 * POST /follow-ups/:id/accept | /decline (idParam)
 * ------------------------------------------------------------------ */

func (s *Server) handleFollowUpAccept(w http.ResponseWriter, r *http.Request) {
	s.followUpRespondHandler(w, r, true)
}

func (s *Server) handleFollowUpDecline(w http.ResponseWriter, r *http.Request) {
	s.followUpRespondHandler(w, r, false)
}

func (s *Server) followUpRespondHandler(w http.ResponseWriter, r *http.Request, accept bool) {
	id := chi.URLParam(r, "id")
	if !apptUUID7OK(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return
	}
	fallback := "Failed to accept follow-up."
	if !accept {
		fallback = "Failed to decline follow-up."
	}
	result, err := s.followUpRespond(r.Context(), id, CurrentUser(r).ID, accept)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, fallback)
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": result})
}

func (s *Server) followUpRespond(ctx context.Context, followUpID, patientID string, accept bool) (map[string]any, error) {
	var (
		row        followUpRow
		apptUserID string
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT f.id, f.appointmentId, f.doctorId, f.suggestedDate, f.startTime, f.endTime, f.consultationType, f.notes, f.status, f.createdAt, a.userId "+
			"FROM `FollowUp` f JOIN `Appointment` a ON a.id = f.appointmentId WHERE f.id = ?", followUpID).
		Scan(&row.ID, &row.AppointmentID, &row.DoctorID, &row.SuggestedDate, &row.StartTime, &row.EndTime,
			&row.ConsultationType, &row.Notes, &row.Status, &row.CreatedAt, &apptUserID)
	if err == sql.ErrNoRows {
		return nil, NotFound("Follow-up not found")
	}
	if err != nil {
		return nil, err
	}
	if apptUserID != patientID {
		return nil, Forbidden("not your appointment")
	}
	if row.Status != "pending" {
		return nil, Conflict("This follow-up was already responded to")
	}

	if !accept {
		// Claimed, not assigned: a decline that read `pending` before a
		// concurrent accept's claim committed must not write over it.
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `FollowUp` SET status = 'declined' WHERE id = ? AND status = 'pending'", followUpID)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, Conflict("This follow-up was already responded to")
		}
		updated, err := scanFollowUpRow(s.DB.QueryRowContext(ctx, "SELECT "+followUpColumns+" FROM `FollowUp` WHERE id = ?", followUpID))
		if err != nil {
			return nil, err
		}
		return map[string]any{"followUp": updated.JSON(), "appointment": nil}, nil
	}

	// The doctor's user id is what the acceptance notification goes to.
	var doctorUserID string
	err = s.DB.QueryRowContext(ctx,
		"SELECT d.userId FROM `Doctor` d JOIN `Appointment` a ON a.doctorId = d.id WHERE a.id = ?", row.AppointmentID).
		Scan(&doctorUserID)
	if err == sql.ErrNoRows {
		return nil, NotFound("Appointment not found")
	}
	if err != nil {
		return nil, err
	}

	// A suggestion for a date that has already passed can no longer be
	// accepted.
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	suggested := row.SuggestedDate.UTC()
	if suggested.Before(today) {
		return nil, Conflict("This follow-up date has already passed — please ask your doctor for a new time")
	}

	start, startOK := apptTimeToMinutes(row.StartTime)
	end, endOK := apptTimeToMinutes(row.EndTime)
	if !startOK || !endOK {
		return nil, BadRequest("This follow-up has an invalid time")
	}
	if start >= end {
		return nil, BadRequest("This follow-up has an invalid time range")
	}

	dayStart := time.Date(suggested.Year(), suggested.Month(), suggested.Day(), 0, 0, 0, 0, time.UTC)
	dayEnd := dayStart.AddDate(0, 0, 1)
	conflictRows, err := s.DB.QueryContext(ctx,
		"SELECT startTime, endTime FROM `Appointment` WHERE doctorId = ? AND appointmentDate >= ? AND appointmentDate < ? AND status IN ('pending','confirmed')",
		row.DoctorID, dayStart, dayEnd)
	if err != nil {
		return nil, err
	}
	hasConflict := false
	for conflictRows.Next() {
		var bStart, bEnd *string
		if err := conflictRows.Scan(&bStart, &bEnd); err != nil {
			conflictRows.Close()
			return nil, err
		}
		bS, bSOK := apptTimeToMinutes(apptStrOr(bStart, ""))
		bE, bEOK := apptTimeToMinutes(apptStrOr(bEnd, ""))
		if bSOK && bEOK && apptOverlap(start, end, bS, bE) {
			hasConflict = true
		}
	}
	conflictRows.Close()
	if err := conflictRows.Err(); err != nil {
		return nil, err
	}
	if hasConflict {
		return nil, Conflict("That time is already booked for this doctor — please ask them for another slot")
	}

	notes := row.Notes
	if notes == nil || *notes == "" {
		fallback := "Follow-up session"
		notes = &fallback
	}

	// Claim and create inside one transaction, so a failure between the two
	// cannot leave a `pending` follow-up beside a duplicate booking on retry.
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	claim, err := tx.ExecContext(ctx,
		"UPDATE `FollowUp` SET status = 'accepted' WHERE id = ? AND status = 'pending'", followUpID)
	if err != nil {
		return nil, err
	}
	if n, _ := claim.RowsAffected(); n != 1 {
		return nil, Conflict("This follow-up was already responded to")
	}

	packageID, creditApplied, err := s.followUpConsumeReservation(ctx, tx, patientID, row.DoctorID)
	if err != nil {
		return nil, err
	}

	appointmentID := newID()
	insertNow := time.Now().UTC()
	_, err = tx.ExecContext(ctx,
		"INSERT INTO `Appointment` (id, userId, doctorId, appointmentDate, startTime, endTime, consultationType, notes, "+
			"status, creditApplied, packagePurchaseId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
		appointmentID, patientID, row.DoctorID, suggested, row.StartTime, row.EndTime, row.ConsultationType,
		notes, "pending", creditApplied, packageID, insertNow, insertNow)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	created := &apptRow{
		ID:                appointmentID,
		UserID:            patientID,
		DoctorID:          row.DoctorID,
		AppointmentDate:   suggested,
		StartTime:         &row.StartTime,
		EndTime:           &row.EndTime,
		ConsultationType:  row.ConsultationType,
		Status:            "pending",
		Notes:             notes,
		PackagePurchaseID: packageID,
		CreditApplied:     creditApplied,
		CreatedAt:         insertNow,
		UpdatedAt:         insertNow,
	}

	// The doctor is told to confirm the new session.
	s.apptNotify(ctx, doctorUserID, "Follow-up accepted",
		"Your patient accepted the follow-up on "+apptFormatGB(suggested)+" at "+row.StartTime+". Please confirm it.",
		"appointment")

	// The Node response spreads the loaded follow-up row (which carries the
	// `appointment` include) and overrides the status.
	followUpJSON := row.JSON()
	followUpJSON["status"] = "accepted"
	followUpJSON["appointment"] = map[string]any{"userId": apptUserID}

	return map[string]any{"followUp": followUpJSON, "appointment": created.JSON()}, nil
}

// followUpConsumeReservation ports findConsumableReservation: every branch is
// a conditional claim that checks it won, so one remaining session cannot be
// spent by two concurrent acceptances.
func (s *Server) followUpConsumeReservation(ctx context.Context, tx *sql.Tx, patientID, doctorID string) (*string, bool, error) {
	rows, err := tx.QueryContext(ctx,
		"SELECT p.id FROM `PackagePurchase` p JOIN `Package` pk ON pk.id = p.packageId "+
			"WHERE p.userId = ? AND p.sessionsLeft > 0 AND p.status = 'active' AND pk.doctorId = ? "+
			"ORDER BY p.createdAt ASC", patientID, doctorID)
	if err != nil {
		return nil, false, err
	}
	var candidates []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, false, err
		}
		candidates = append(candidates, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	for _, candidate := range candidates {
		res, err := tx.ExecContext(ctx,
			"UPDATE `PackagePurchase` SET sessionsLeft = sessionsLeft - 1 WHERE id = ? AND sessionsLeft > 0", candidate)
		if err != nil {
			return nil, false, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			continue
		}
		// Exhausted packages flip to completed, matching the booking path.
		if _, err := tx.ExecContext(ctx,
			"UPDATE `PackagePurchase` SET status = 'completed' WHERE id = ? AND sessionsLeft = 0", candidate); err != nil {
			return nil, false, err
		}
		id := candidate
		return &id, false, nil
	}

	// Credits last, and conditionally for the same reason: an unconditional
	// decrement of two concurrent requests from 1 leaves the balance at -1.
	res, err := tx.ExecContext(ctx,
		"UPDATE `User` SET sessionCredits = sessionCredits - 1, updatedAt = ? WHERE id = ? AND sessionCredits > 0",
		time.Now().UTC(), patientID)
	if err != nil {
		return nil, false, err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return nil, true, nil
	}
	return nil, false, nil
}

// apptEnsureRoomSeed and the rest of the shared helpers live in
// routes_appointments.go; this file only defines the follow-up flow.
