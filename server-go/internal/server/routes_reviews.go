package server

import (
	"context"
	"database/sql"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

// registerReviews is the port of server/src/routes/review.routes.ts.
func (s *Server) registerReviews(api chi.Router) {
	// Public, unauthenticated listing by design: reviews belong on a
	// clinician's public profile.
	api.Get("/reviews/doctor/{doctorId}/summary", s.handleReviewSummary)
	api.Get("/reviews/doctor/{doctorId}", s.handleReviewList)

	api.Group(func(api chi.Router) {
		api.Use(s.authenticate)
		api.Post("/reviews", s.handleReviewCreate)
		api.Post("/reviews/{id}/reply", s.handleReviewReply)
	})

	// Reporting is rate-limited per doctor-user, tightly.
	reportRate := s.limiter(rateLimitConfig{
		name:    "write:review report",
		window:  time.Hour,
		max:     10,
		message: "Too many review report requests, please slow down",
		key: func(r *http.Request) string {
			if u := CurrentUser(r); u != nil {
				return "u" + u.ID
			}
			return "ip:" + remoteIP(r, s.Cfg.IsProd)
		},
	})
	api.With(s.authenticate, reportRate).Post("/reviews/{id}/report", s.handleReviewReport)
}

/* ------------------------------------------------------------------ *
 * Row scanning / JSON shaping
 * ------------------------------------------------------------------ */

const reviewColumns = "id, rating, comment, userId, doctorId, appointmentId, reply, repliedAt, hidden, createdAt"

type reviewRow struct {
	ID            string
	Rating        int
	Comment       string
	UserID        string
	DoctorID      string
	AppointmentID *string
	Reply         *string
	RepliedAt     *time.Time
	Hidden        bool
	CreatedAt     time.Time
}

func scanReviewRow(sc apptScanner) (*reviewRow, error) {
	var rv reviewRow
	err := sc.Scan(&rv.ID, &rv.Rating, &rv.Comment, &rv.UserID, &rv.DoctorID, &rv.AppointmentID,
		&rv.Reply, &rv.RepliedAt, &rv.Hidden, &rv.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &rv, nil
}

func (rv *reviewRow) JSON() map[string]any {
	return map[string]any{
		"id":            rv.ID,
		"rating":        rv.Rating,
		"comment":       rv.Comment,
		"userId":        rv.UserID,
		"doctorId":      rv.DoctorID,
		"appointmentId": rv.AppointmentID,
		"reply":         rv.Reply,
		"repliedAt":     jsTime(rv.RepliedAt),
		"hidden":        rv.Hidden,
		"createdAt":     jsTimeValue(rv.CreatedAt),
	}
}

/* ------------------------------------------------------------------ *
 * Public display names (review.service.ts publicDisplayName)
 * ------------------------------------------------------------------ */

var reviewPseudonymAdjectives = []string{
	"Calm", "Thoughtful", "Steady", "Kind", "Quiet", "Brave",
	"Gentle", "Patient", "Honest", "Open", "Grounded", "Hopeful",
}

var reviewPseudonymNouns = []string{
	"Otter", "Heron", "Willow", "Lark", "Cedar", "Finch",
	"Meadow", "Slate", "Aspen", "Heron", "Kestrel", "Sorrel",
}

// reviewPseudoIndex is the FNV-1a 32-bit hash the Node service uses, with the
// same wrapping unsigned arithmetic (`Math.imul` plus `>>> 0`).
func reviewPseudoIndex(seed string, length int) int {
	hash := uint32(2166136261)
	for i := 0; i < len(seed); i++ {
		hash ^= uint32(seed[i])
		hash *= 16777619
	}
	return int(hash % uint32(length))
}

func reviewDisplayName(userID string) string {
	a := reviewPseudonymAdjectives[reviewPseudoIndex(userID, len(reviewPseudonymAdjectives))]
	b := reviewPseudonymNouns[reviewPseudoIndex(userID+":b", len(reviewPseudonymNouns))]
	return a + " " + b
}

/* ------------------------------------------------------------------ *
 * Rating recalculation
 * ------------------------------------------------------------------ */

// reviewRecalcDoctorRating is the single writer of Doctor.rating and
// totalReviews: a clinician with no visible reviews has no rating, never a
// fabricated 5.0.
func (s *Server) reviewRecalcDoctorRating(ctx context.Context, doctorID string) error {
	var avg sql.NullFloat64
	var count int
	if err := s.DB.QueryRowContext(ctx,
		"SELECT AVG(rating), COUNT(*) FROM `Review` WHERE doctorId = ? AND hidden = false", doctorID).
		Scan(&avg, &count); err != nil {
		return err
	}
	rating := 0.0
	if count > 0 {
		rating = math.Round(avg.Float64*10) / 10
	}
	_, err := s.DB.ExecContext(ctx,
		"UPDATE `Doctor` SET rating = ?, totalReviews = ?, updatedAt = ? WHERE id = ?",
		rating, count, time.Now().UTC(), doctorID)
	return err
}

func (s *Server) reviewAggregate(ctx context.Context, doctorID string) (float64, int, error) {
	var avg sql.NullFloat64
	var count int
	err := s.DB.QueryRowContext(ctx,
		"SELECT AVG(rating), COUNT(*) FROM `Review` WHERE doctorId = ? AND hidden = false", doctorID).
		Scan(&avg, &count)
	if err != nil {
		return 0, 0, err
	}
	if count == 0 {
		return 0, 0, nil
	}
	return avg.Float64, count, nil
}

/* ------------------------------------------------------------------ *
 * POST /reviews (CreateReviewSchema)
 * ------------------------------------------------------------------ */

type reviewCreateBody struct {
	DoctorID      string   `json:"doctorId"`
	AppointmentID string   `json:"appointmentId"`
	Rating        *float64 `json:"rating"`
	Comment       *string  `json:"comment"`
}

func (s *Server) handleReviewCreate(w http.ResponseWriter, r *http.Request) {
	var body reviewCreateBody
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if !apptUUID7OK(body.DoctorID) {
		s.validationFail(w, "body.doctorId", "Invalid id")
		return
	}
	if !apptUUID7OK(body.AppointmentID) {
		s.validationFail(w, "body.appointmentId", "Invalid id")
		return
	}
	if body.Rating == nil {
		s.validationFail(w, "body.rating", "Invalid input: expected number, received undefined")
		return
	}
	if *body.Rating != math.Trunc(*body.Rating) {
		s.validationFail(w, "body.rating", "Invalid input: expected int, received number")
		return
	}
	if *body.Rating < 1 {
		s.validationFail(w, "body.rating", "Too small: expected number to be >=1")
		return
	}
	if *body.Rating > 5 {
		s.validationFail(w, "body.rating", "Rating must be between 1 and 5")
		return
	}
	if body.Comment == nil {
		s.validationFail(w, "body.comment", "Invalid input: expected string, received undefined")
		return
	}
	if len([]rune(*body.Comment)) < 3 {
		s.validationFail(w, "body.comment", "Comment must be at least 3 characters")
		return
	}
	if len([]rune(*body.Comment)) > 2000 {
		s.validationFail(w, "body.comment", "Comment too long")
		return
	}

	result, err := s.reviewCreate(r.Context(), CurrentUser(r).ID, &body)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to create review.")
		return
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": result})
}

func (s *Server) reviewCreate(ctx context.Context, userID string, body *reviewCreateBody) (map[string]any, error) {
	// The appointment must exist, belong to the reviewer, match the doctor and
	// be completed.
	var appointmentID string
	err := s.DB.QueryRowContext(ctx,
		"SELECT id FROM `Appointment` WHERE id = ? AND userId = ? AND doctorId = ? AND status = 'completed'",
		body.AppointmentID, userID, body.DoctorID).Scan(&appointmentID)
	if err == sql.ErrNoRows {
		return nil, BadRequest("Invalid appointment or not eligible for review.")
	}
	if err != nil {
		return nil, err
	}

	// One review per appointment.
	var existing int
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Review` WHERE appointmentId = ?", body.AppointmentID).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, Conflict("You have already reviewed this appointment.")
	}

	reviewID := newID()
	now := time.Now().UTC()
	comment := s.apptSanitizeText(*body.Comment)
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `Review` (id, rating, comment, userId, doctorId, appointmentId, hidden, createdAt) VALUES (?,?,?,?,?,?,?,?)",
		reviewID, int(*body.Rating), comment, userID, body.DoctorID, body.AppointmentID, false, now)
	if err != nil {
		return nil, err
	}

	// Exactly one writer for the doctor's aggregate.
	if err := s.reviewRecalcDoctorRating(ctx, body.DoctorID); err != nil {
		return nil, err
	}
	avg, count, err := s.reviewAggregate(ctx, body.DoctorID)
	if err != nil {
		return nil, err
	}

	review, err := scanReviewRow(s.DB.QueryRowContext(ctx, "SELECT "+reviewColumns+" FROM `Review` WHERE id = ?", reviewID))
	if err != nil {
		return nil, err
	}
	out := review.JSON()
	var name, avatar *string
	if err := s.DB.QueryRowContext(ctx, "SELECT name, avatar FROM `User` WHERE id = ?", userID).Scan(&name, &avatar); err != nil {
		return nil, err
	}
	out["user"] = map[string]any{"id": userID, "name": name, "avatar": avatar}

	var averageRating any
	if count > 0 {
		averageRating = avg
	}
	return map[string]any{
		"review":        out,
		"averageRating": averageRating,
		"totalReviews":  count,
	}, nil
}

/* ------------------------------------------------------------------ *
 * GET /reviews/doctor/:doctorId
 * ------------------------------------------------------------------ */

func (s *Server) handleReviewList(w http.ResponseWriter, r *http.Request) {
	doctorID := chi.URLParam(r, "doctorId")
	if !apptUUID7OK(doctorID) {
		s.Fail(w, http.StatusBadRequest, "Invalid doctor id")
		return
	}
	limit := apptClampInt(r.URL.Query().Get("limit"), 20, 1, 50)
	offset := apptClampInt(r.URL.Query().Get("offset"), 0, 0, 100000)

	items, total, err := s.reviewList(r.Context(), doctorID, limit, offset)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch reviews.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data":   items,
		"pagination": map[string]any{
			"total":  total,
			"limit":  limit,
			"offset": offset,
		},
	})
}

// reviewList returns the public projection: the reviewer's identity is never
// selected, only a stable pseudonym derived from the user id.
func (s *Server) reviewList(ctx context.Context, doctorID string, limit, offset int) ([]map[string]any, int, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, rating, comment, reply, repliedAt, createdAt, userId FROM `Review` "+
			"WHERE doctorId = ? AND hidden = false ORDER BY createdAt DESC LIMIT ? OFFSET ?",
		doctorID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var (
			id, comment, userID string
			rating              int
			reply               *string
			repliedAt           *time.Time
			createdAt           time.Time
		)
		if err := rows.Scan(&id, &rating, &comment, &reply, &repliedAt, &createdAt, &userID); err != nil {
			return nil, 0, err
		}
		items = append(items, map[string]any{
			"id":          id,
			"rating":      rating,
			"comment":     comment,
			"reply":       reply,
			"repliedAt":   jsTime(repliedAt),
			"createdAt":   jsTimeValue(createdAt),
			"displayName": reviewDisplayName(userID),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	var total int
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Review` WHERE doctorId = ? AND hidden = false", doctorID).Scan(&total); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

/* ------------------------------------------------------------------ *
 * GET /reviews/doctor/:doctorId/summary
 * ------------------------------------------------------------------ */

func (s *Server) handleReviewSummary(w http.ResponseWriter, r *http.Request) {
	doctorID := chi.URLParam(r, "doctorId")

	avg, count, err := s.reviewAggregate(r.Context(), doctorID)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch rating summary.")
		return
	}

	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT rating, COUNT(*) FROM `Review` WHERE doctorId = ? AND hidden = false GROUP BY rating", doctorID)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch rating summary.")
		return
	}
	defer rows.Close()
	distribution := map[string]int{}
	for rows.Next() {
		var rating, n int
		if err := rows.Scan(&rating, &n); err != nil {
			s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch rating summary.")
			return
		}
		distribution[strconv.Itoa(rating)] = n
	}
	if err := rows.Err(); err != nil {
		s.apptControllerErr(w, r, err, http.StatusInternalServerError, "Failed to fetch rating summary.")
		return
	}

	averageRating := 0.0
	if count > 0 {
		averageRating = math.Round(avg*10) / 10
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"averageRating": averageRating,
		"totalReviews":  count,
		"distribution":  distribution,
	}})
}

/* ------------------------------------------------------------------ *
 * POST /reviews/:id/reply (ReplyReviewSchema)
 * ------------------------------------------------------------------ */

func (s *Server) handleReviewReply(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Reply *string `json:"reply"`
	}
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if body.Reply == nil {
		s.validationFail(w, "body.reply", "Invalid input: expected string, received undefined")
		return
	}
	if len([]rune(*body.Reply)) < 1 {
		s.validationFail(w, "body.reply", "Reply cannot be empty")
		return
	}
	if len([]rune(*body.Reply)) > 2000 {
		s.validationFail(w, "body.reply", "Reply too long")
		return
	}

	doctorUserID := CurrentUser(r).ID
	review, err := s.reviewByID(r.Context(), id)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to reply to review.")
		return
	}
	var ownerUserID string
	if err := s.DB.QueryRowContext(r.Context(), "SELECT userId FROM `Doctor` WHERE id = ?", review.DoctorID).Scan(&ownerUserID); err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to reply to review.")
		return
	}
	if ownerUserID != doctorUserID {
		s.apptControllerErr(w, r, Forbidden("you can only reply to reviews on your own profile"), http.StatusBadRequest, "Failed to reply to review.")
		return
	}

	cleaned := s.apptSanitizeText(*body.Reply)
	if cleaned == "" {
		s.apptControllerErr(w, r, BadRequest("Reply cannot be empty"), http.StatusBadRequest, "Failed to reply to review.")
		return
	}

	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(r.Context(),
		"UPDATE `Review` SET reply = ?, repliedAt = ? WHERE id = ?", cleaned, now, id); err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to reply to review.")
		return
	}
	review, err = s.reviewByID(r.Context(), id)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to reply to review.")
		return
	}

	s.audit(r.Context(), "review.reply", &doctorUserID, ptr("Review"), &id, map[string]any{"doctorId": review.DoctorID})

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": review.JSON()})
}

/* ------------------------------------------------------------------ *
 * POST /reviews/:id/report (ReportReviewSchema)
 * ------------------------------------------------------------------ */

func (s *Server) handleReviewReport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Reason *string `json:"reason"`
	}
	if err := apptDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if body.Reason == nil {
		s.validationFail(w, "body.reason", "Invalid input: expected string, received undefined")
		return
	}
	if len([]rune(*body.Reason)) < 5 {
		s.validationFail(w, "body.reason", "Please describe the issue")
		return
	}
	if len([]rune(*body.Reason)) > 2000 {
		s.validationFail(w, "body.reason", "Reason too long")
		return
	}

	doctorUserID := CurrentUser(r).ID
	review, err := s.reviewByID(r.Context(), id)
	if err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to report review.")
		return
	}
	var ownerUserID string
	if err := s.DB.QueryRowContext(r.Context(), "SELECT userId FROM `Doctor` WHERE id = ?", review.DoctorID).Scan(&ownerUserID); err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to report review.")
		return
	}
	if ownerUserID != doctorUserID {
		s.apptControllerErr(w, r, Forbidden("you can only report reviews on your own profile"), http.StatusBadRequest, "Failed to report review.")
		return
	}

	// One open report per review.
	var open int
	if err := s.DB.QueryRowContext(r.Context(),
		"SELECT COUNT(*) FROM `ReviewReport` WHERE reviewId = ? AND status = 'open'", id).Scan(&open); err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to report review.")
		return
	}
	if open > 0 {
		s.apptControllerErr(w, r, Conflict("This review already has an open report"), http.StatusBadRequest, "Failed to report review.")
		return
	}

	reportID := newID()
	now := time.Now().UTC()
	reason := s.apptSanitizeClip(*body.Reason, 2000)
	if _, err := s.DB.ExecContext(r.Context(),
		"INSERT INTO `ReviewReport` (id, reviewId, reporterId, reason, status, createdAt) VALUES (?,?,?,?,?,?)",
		reportID, id, doctorUserID, reason, "open", now); err != nil {
		s.apptControllerErr(w, r, err, http.StatusBadRequest, "Failed to report review.")
		return
	}

	s.audit(r.Context(), "review.report", &doctorUserID, ptr("Review"), &id, map[string]any{
		"reportId": reportID, "doctorId": review.DoctorID,
	})

	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{
		"id":         reportID,
		"reviewId":   id,
		"reporterId": doctorUserID,
		"reason":     reason,
		"status":     "open",
		"createdAt":  jsTimeValue(now),
	}})
}

func (s *Server) reviewByID(ctx context.Context, id string) (*reviewRow, error) {
	review, err := scanReviewRow(s.DB.QueryRowContext(ctx, "SELECT "+reviewColumns+" FROM `Review` WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return nil, NotFound("Review not found")
	}
	if err != nil {
		return nil, err
	}
	return review, nil
}
