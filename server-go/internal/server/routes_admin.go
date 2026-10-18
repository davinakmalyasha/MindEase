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
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
)

// registerAdmin is the port of server/src/routes/admin.routes.ts. Every route
// is admin-only: the Express router mounts `authenticate, requireAdmin` ahead
// of everything, and the per-route schemas are validated in the handlers (in
// the same order the wrapper schema checks them: body before params).
func (s *Server) registerAdmin(api chi.Router) {
	api.Group(func(api chi.Router) {
		api.Use(s.authenticate, s.RequireRole("admin"))

		api.Get("/admin/stats", s.handleAdminStats)
		api.Get("/admin/users", s.handleAdminUsers)
		api.Patch("/admin/users/{id}/role", s.handleAdminUpdateUserRole)
		api.Patch("/admin/users/{id}/ban", s.handleAdminToggleBan)
		api.Get("/admin/doctors/applications", s.handleAdminDoctorApplications)
		api.Patch("/admin/doctors/{id}/verification", s.handleAdminDoctorVerification)
		api.Post("/admin/broadcast", s.handleAdminBroadcast)
		api.Get("/admin/audit-logs", s.handleAdminAuditLogs)

		// Who read this patient's record, and when. Separate from
		// `/audit-logs` because that endpoint is a time-ordered page of
		// everything, and the question an access log is for is "who has seen
		// *this person*".
		api.Get("/admin/audit-logs/patient/{id}", s.handleAdminPatientAccessLog)
		api.Get("/admin/review-reports", s.handleAdminReviewReports)
		api.Post("/admin/reviews/{id}/hide", s.handleAdminHideReview)
		api.Post("/admin/review-reports/{id}/status", s.handleAdminResolveReviewReport)
		api.Get("/admin/export/{kind}", s.handleAdminExport)
	})
}

/* ------------------------------------------------------------------ *
 * Shared validation helpers (schemas/admin.schema.ts + params.schema.ts)
 * ------------------------------------------------------------------ */

var adminUUID7Re = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// adminFail is the controllers' single catch-block behaviour: a typed domain
// error keeps its status and message, anything else is logged and becomes the
// generic 500 message. Every admin handler uses it, matching the Node
// `catch { res.status(500)... }` in admin.controller.ts.
func (s *Server) adminFail(w http.ResponseWriter, r *http.Request, err error) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("admin handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, http.StatusInternalServerError, "Something went wrong. Please try again.")
}

// adminParamID mirrors validate(idParam): the uuid7 params schema with the
// "Invalid id" message.
func (s *Server) adminParamID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if !adminUUID7Re.MatchString(id) {
		s.validationFail(w, "params.id", "Invalid id")
		return "", false
	}
	return id, true
}

// adminJSONTypeName names a JSON value the way Zod does in "received X".
func adminJSONTypeName(raw json.RawMessage) string {
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

// adminUTF16Len counts UTF-16 code units, which is the unit Zod's
// `min`/`max` on strings uses (a string's `.length` in JavaScript).
func adminUTF16Len(value string) int {
	units := 0
	for _, r := range value {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// adminBodyObject reads the request body as an object the way the validate
// middleware does: an absent/empty body is `{}`, and a non-object root is the
// Zod "expected object" failure.
func (s *Server) adminBodyObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			s.Fail(w, http.StatusBadRequest, "request entity too large")
			return nil, false
		}
		s.validationFail(w, "body", "Validation Error")
		return nil, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return map[string]json.RawMessage{}, true
	}
	if trimmed[0] != '{' {
		s.validationFail(w, "body", "Invalid input: expected object, received "+adminJSONTypeName(json.RawMessage(trimmed)))
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(trimmed), &fields); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return nil, false
	}
	return fields, true
}

// adminValidateEnumField mirrors `z.enum(values, customMessage)`: every
// failure - missing, wrong type, or not a member - carries the custom message.
func (s *Server) adminValidateEnumField(w http.ResponseWriter, fields map[string]json.RawMessage, key, path, message string, allowed ...string) (string, bool) {
	raw, present := fields[key]
	if !present {
		s.validationFail(w, path, message)
		return "", false
	}
	var value string
	if adminJSONTypeName(raw) != "string" || json.Unmarshal(raw, &value) != nil || !containsString(allowed, value) {
		s.validationFail(w, path, message)
		return "", false
	}
	return value, true
}

// adminValidateStringField mirrors `z.string().min(1).max(max)` with Zod 4's
// exact messages, counting UTF-16 code units for the bounds.
func (s *Server) adminValidateStringField(w http.ResponseWriter, fields map[string]json.RawMessage, key, path string, max int) (string, bool) {
	raw, present := fields[key]
	if !present {
		s.validationFail(w, path, "Invalid input: expected string, received undefined")
		return "", false
	}
	if adminJSONTypeName(raw) != "string" {
		s.validationFail(w, path, "Invalid input: expected string, received "+adminJSONTypeName(raw))
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		s.validationFail(w, path, "Invalid input: expected string, received string")
		return "", false
	}
	if adminUTF16Len(value) < 1 {
		s.validationFail(w, path, "Too small: expected string to have >=1 characters")
		return "", false
	}
	if adminUTF16Len(value) > max {
		s.validationFail(w, path, fmt.Sprintf("Too big: expected string to have <=%d characters", max))
		return "", false
	}
	return value, true
}

// adminJsParseInt mimics JavaScript's parseInt(value, 10): leading whitespace,
// an optional sign, then digits up to the first non-digit. ok=false is NaN.
func adminJsParseInt(value string) (int, bool) {
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

// adminJsIntOr mirrors `parseInt(value) || fallback`.
func adminJsIntOr(value string, fallback int) int {
	if v, ok := adminJsParseInt(value); ok && v != 0 {
		return v
	}
	return fallback
}

// adminSanitize ports utils/sanitize.ts: trim, strip every tag, cap at 4000
// UTF-16 code units. s.Sanitizer is the port's UGC policy, so a second
// strip-tags pass reproduces the Node `allowedTags: []` output exactly.
var adminStripTagsPolicy = bluemonday.StripTagsPolicy()

func (s *Server) adminSanitize(input string) string {
	cleaned := s.Sanitizer.Sanitize(strings.TrimSpace(input))
	cleaned = adminStripTagsPolicy.Sanitize(cleaned)
	units := 0
	for i, r := range cleaned {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > 4000 {
			return cleaned[:i]
		}
		units += size
	}
	return cleaned
}

/* ------------------------------------------------------------------ *
 * Doctor row shape
 * ------------------------------------------------------------------ */

const adminDoctorColumns = "d.id, d.userId, d.specialty, d.bio, d.experience, d.rating, d.totalReviews, " +
	"d.languages, d.education, d.price, d.bankName, d.bankAccount, d.bankHolder, d.availability, " +
	"d.verificationStatus, d.licenseNumber, d.licenseIssuer, d.awayUntil, d.createdAt, d.updatedAt"

type adminRowScanner interface {
	Scan(dest ...any) error
}

type adminDoctorRow struct {
	ID                 string
	UserID             string
	Specialty          string
	Bio                string
	Experience         int
	Rating             float64
	TotalReviews       int
	Languages          *string
	Education          *string
	Price              int
	BankName           *string
	BankAccount        *string
	BankHolder         *string
	Availability       string
	VerificationStatus string
	LicenseNumber      *string
	LicenseIssuer      *string
	AwayUntil          *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

func (d *adminDoctorRow) scanDest() []any {
	return []any{
		&d.ID, &d.UserID, &d.Specialty, &d.Bio, &d.Experience, &d.Rating, &d.TotalReviews,
		&d.Languages, &d.Education, &d.Price, &d.BankName, &d.BankAccount, &d.BankHolder,
		&d.Availability, &d.VerificationStatus, &d.LicenseNumber, &d.LicenseIssuer,
		&d.AwayUntil, &d.CreatedAt, &d.UpdatedAt,
	}
}

// JSON renders every Doctor scalar the way a Prisma `include`/`update` does.
func (d *adminDoctorRow) JSON() map[string]any {
	return map[string]any{
		"id":                 d.ID,
		"userId":             d.UserID,
		"specialty":          d.Specialty,
		"bio":                d.Bio,
		"experience":         d.Experience,
		"rating":             d.Rating,
		"totalReviews":       d.TotalReviews,
		"languages":          d.Languages,
		"education":          d.Education,
		"price":              d.Price,
		"bankName":           d.BankName,
		"bankAccount":        d.BankAccount,
		"bankHolder":         d.BankHolder,
		"availability":       d.Availability,
		"verificationStatus": d.VerificationStatus,
		"licenseNumber":      d.LicenseNumber,
		"licenseIssuer":      d.LicenseIssuer,
		"awayUntil":          jsTime(d.AwayUntil),
		"createdAt":          jsTimeValue(d.CreatedAt),
		"updatedAt":          jsTimeValue(d.UpdatedAt),
	}
}

func adminScanDoctor(sc adminRowScanner) (*adminDoctorRow, error) {
	var d adminDoctorRow
	if err := sc.Scan(d.scanDest()...); err != nil {
		return nil, err
	}
	return &d, nil
}

// adminRecalcDoctorRating is the one writer of Doctor.rating/totalReviews on
// the admin side, ported from ReviewService.recalcDoctorRating: a clinician
// with no visible reviews has no rating, never a fabricated 5.0.
func (s *Server) adminRecalcDoctorRating(ctx context.Context, doctorID string) error {
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

/* ------------------------------------------------------------------ *
 * GET /admin/stats
 * ------------------------------------------------------------------ */

func (s *Server) adminCount(ctx context.Context, query string, args ...any) (int, error) {
	var n int
	err := s.DB.QueryRowContext(ctx, query, args...).Scan(&n)
	return n, err
}

func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	twelveMonthsAgo := time.Date(today.Year(), today.Month()-11, 1, 0, 0, 0, 0, time.Local)

	totalPatients, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `User` WHERE role = 'patient'")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	totalDoctors, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `User` WHERE role = 'doctor'")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	successfulBookings, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `Appointment` WHERE status = 'completed'")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	pendingAppointments, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `Appointment` WHERE status = 'pending'")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	totalAppointments, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `Appointment`")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	newUsersToday, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `User` WHERE createdAt >= ?", today)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	// The KPI is total estimated revenue, all time, separate from the 12-month
	// trend on purpose.
	var lifetimeRevenue float64
	if err := s.DB.QueryRowContext(ctx,
		"SELECT COALESCE(SUM(d.price), 0) AS revenue FROM `Appointment` a "+
			"JOIN `Doctor` d ON d.id = a.doctorId WHERE a.status = 'completed'").Scan(&lifetimeRevenue); err != nil {
		s.adminFail(w, r, err)
		return
	}

	type adminMonthRevenue struct {
		month    string
		revenue  float64
		bookings int
	}
	revenueByMonth := []adminMonthRevenue{}
	rows, err := s.DB.QueryContext(ctx,
		"SELECT DATE_FORMAT(a.appointmentDate, '%Y-%m') AS month, "+
			"COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS bookings "+
			"FROM `Appointment` a JOIN `Doctor` d ON d.id = a.doctorId "+
			"WHERE a.status = 'completed' AND a.appointmentDate >= ? "+
			"GROUP BY DATE_FORMAT(a.appointmentDate, '%Y-%m')", twelveMonthsAgo)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	for rows.Next() {
		var m adminMonthRevenue
		if err := rows.Scan(&m.month, &m.revenue, &m.bookings); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		revenueByMonth = append(revenueByMonth, m)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	packageRevenueByMonth := []adminMonthRevenue{}
	prows, err := s.DB.QueryContext(ctx,
		"SELECT DATE_FORMAT(pp.createdAt, '%Y-%m') AS month, COALESCE(SUM(p.totalPrice), 0) AS revenue "+
			"FROM `PackagePurchase` pp JOIN `Package` p ON p.id = pp.packageId "+
			"WHERE pp.paidAt IS NOT NULL AND pp.createdAt >= ? "+
			"GROUP BY DATE_FORMAT(pp.createdAt, '%Y-%m')", twelveMonthsAgo)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	for prows.Next() {
		var m adminMonthRevenue
		if err := prows.Scan(&m.month, &m.revenue); err != nil {
			prows.Close()
			s.adminFail(w, r, err)
			return
		}
		packageRevenueByMonth = append(packageRevenueByMonth, m)
	}
	if err := prows.Err(); err != nil {
		prows.Close()
		s.adminFail(w, r, err)
		return
	}
	prows.Close()

	type adminMonthBucket struct {
		key      string
		label    string
		revenue  float64
		bookings int
	}
	buckets := make([]adminMonthBucket, 0, 12)
	byKey := map[string]int{}
	for i := 11; i >= 0; i-- {
		d := time.Date(today.Year(), today.Month()-time.Month(i), 1, 0, 0, 0, 0, time.Local)
		key := fmt.Sprintf("%d-%02d", d.Year(), int(d.Month()))
		byKey[key] = len(buckets)
		buckets = append(buckets, adminMonthBucket{key: key, label: d.Format("Jan")})
	}
	for _, m := range revenueByMonth {
		if i, ok := byKey[m.month]; ok {
			buckets[i].revenue += m.revenue
			buckets[i].bookings += m.bookings
		}
	}
	for _, m := range packageRevenueByMonth {
		if i, ok := byKey[m.month]; ok {
			buckets[i].revenue += m.revenue
		}
	}
	monthly := make([]map[string]any, 0, 12)
	for _, b := range buckets {
		monthly = append(monthly, map[string]any{
			"key": b.key, "label": b.label, "revenue": b.revenue, "bookings": b.bookings,
		})
	}

	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"total_patients":          totalPatients,
			"total_doctors":           totalDoctors,
			"successful_bookings":     successfulBookings,
			"total_estimated_revenue": lifetimeRevenue,
			"pending_appointments":    pendingAppointments,
			"total_appointments":      totalAppointments,
			"new_users_today":         newUsersToday,
			"monthly_revenue":         monthly,
		},
	})
}

/* ------------------------------------------------------------------ *
 * GET /admin/users
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	page := adminJsIntOr(query.Get("page"), 1)
	limit := adminJsIntOr(query.Get("limit"), 10)
	if limit > 50 {
		limit = 50
	}
	search := strings.TrimSpace(query.Get("search"))
	role := query.Get("role")
	skip := (page - 1) * limit

	where := ""
	args := []any{}
	if search != "" {
		where = " WHERE (name LIKE ? OR email LIKE ?)"
		args = append(args, "%"+search+"%", "%"+search+"%")
	}
	if role != "" {
		if where == "" {
			where = " WHERE role = ?"
		} else {
			where += " AND role = ?"
		}
		args = append(args, role)
	}

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, name, email, role, isBanned, provider, createdAt FROM `User`"+where+
			" ORDER BY createdAt DESC LIMIT ? OFFSET ?", append(args, limit, skip)...)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	users := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id        string
			name      *string
			email     string
			userRole  string
			isBanned  bool
			provider  string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &name, &email, &userRole, &isBanned, &provider, &createdAt); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		users = append(users, map[string]any{
			"id":        id,
			"name":      name,
			"email":     email,
			"role":      userRole,
			"isBanned":  isBanned,
			"provider":  provider,
			"createdAt": jsTimeValue(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	total, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `User`"+where, args...)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	totalPages := 0
	if limit > 0 {
		totalPages = (total + limit - 1) / limit
	}

	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"users": users,
			"pagination": map[string]any{
				"page": page, "limit": limit, "total": total, "totalPages": totalPages,
			},
		},
	})
}

/* ------------------------------------------------------------------ *
 * PATCH /admin/users/:id/role
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminUpdateUserRole(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fields, ok := s.adminBodyObject(w, r)
	if !ok {
		return
	}
	// UpdateUserRoleSchema checks body before params.
	role, ok := s.adminValidateEnumField(w, fields, "role", "body.role", "Invalid role", "patient", "doctor", "admin")
	if !ok {
		return
	}
	userID, ok := s.adminParamID(w, r)
	if !ok {
		return
	}
	actor := CurrentUser(r)
	if userID == actor.ID {
		s.Fail(w, http.StatusBadRequest, "Cannot change your own role")
		return
	}

	var currentRole string
	err := s.DB.QueryRowContext(ctx, "SELECT role FROM `User` WHERE id = ?", userID).Scan(&currentRole)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "User not found")
		return
	}
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET role = ?, updatedAt = ? WHERE id = ?", role, now, userID); err != nil {
		s.adminFail(w, r, err)
		return
	}

	var (
		updatedID        string
		updatedName      *string
		updatedEmail     string
		updatedRoleFinal string
	)
	if err := s.DB.QueryRowContext(ctx,
		"SELECT id, name, email, role FROM `User` WHERE id = ?", userID).
		Scan(&updatedID, &updatedName, &updatedEmail, &updatedRoleFinal); err != nil {
		s.adminFail(w, r, err)
		return
	}

	// Ensure a doctor profile exists when promoted to doctor (Prisma upsert
	// with an empty update).
	if role == "doctor" {
		var exists int
		if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `Doctor` WHERE userId = ?", userID).Scan(&exists); err != nil {
			s.adminFail(w, r, err)
			return
		}
		if exists == 0 {
			if _, err := s.DB.ExecContext(ctx,
				"INSERT INTO `Doctor` (id, userId, specialty, bio, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
				newID(), userID, "General Psychologist", "Experienced mental health professional.", now, now); err != nil {
				s.adminFail(w, r, err)
				return
			}
		}
	}

	s.audit(ctx, "user.role_changed", &actor.ID, ptr("User"), &userID, map[string]any{
		"from": currentRole,
		"to":   role,
	})

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"id": updatedID, "name": updatedName, "email": updatedEmail, "role": updatedRoleFinal,
	}})
}

/* ------------------------------------------------------------------ *
 * PATCH /admin/users/:id/ban
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminToggleBan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := s.adminParamID(w, r)
	if !ok {
		return
	}
	actor := CurrentUser(r)
	if userID == actor.ID {
		s.Fail(w, http.StatusBadRequest, "Cannot ban yourself")
		return
	}

	var wasBanned bool
	err := s.DB.QueryRowContext(ctx, "SELECT isBanned FROM `User` WHERE id = ?", userID).Scan(&wasBanned)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "User not found")
		return
	}
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	// Sessions are deliberately not deleted: `authenticate` re-reads the user
	// on every request, so a ban revokes live sessions immediately.
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET isBanned = ?, updatedAt = ? WHERE id = ?", !wasBanned, time.Now().UTC(), userID); err != nil {
		s.adminFail(w, r, err)
		return
	}

	var (
		id       string
		name     *string
		email    string
		role     string
		isBanned bool
	)
	if err := s.DB.QueryRowContext(ctx,
		"SELECT id, name, email, role, isBanned FROM `User` WHERE id = ?", userID).
		Scan(&id, &name, &email, &role, &isBanned); err != nil {
		s.adminFail(w, r, err)
		return
	}

	action := "user.unbanned"
	if isBanned {
		action = "user.banned"
	}
	s.audit(ctx, action, &actor.ID, ptr("User"), &userID, nil)

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"id": id, "name": name, "email": email, "role": role, "isBanned": isBanned,
	}})
}

/* ------------------------------------------------------------------ *
 * GET /admin/doctors/applications
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminDoctorApplications(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	page := adminJsIntOr(query.Get("page"), 1)
	limit := adminJsIntOr(query.Get("limit"), 20)
	if limit > 50 {
		limit = 50
	}
	status := query.Get("status")
	if status == "" {
		status = "pending"
	}
	skip := (page - 1) * limit

	rows, err := s.DB.QueryContext(ctx,
		"SELECT "+adminDoctorColumns+", u.id, u.name, u.email, u.avatar, u.phone_number, u.createdAt "+
			"FROM `Doctor` d LEFT JOIN `User` u ON u.id = d.userId "+
			"WHERE d.verificationStatus = ? ORDER BY d.createdAt DESC LIMIT ? OFFSET ?",
		status, limit, skip)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	applications := make([]map[string]any, 0)
	for rows.Next() {
		var (
			doctor        adminDoctorRow
			userID        *string
			userName      *string
			userEmail     *string
			userAvatar    *string
			userPhone     *string
			userCreatedAt *time.Time
		)
		dest := append(doctor.scanDest(), &userID, &userName, &userEmail, &userAvatar, &userPhone, &userCreatedAt)
		if err := rows.Scan(dest...); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		app := doctor.JSON()
		if userID != nil {
			app["user"] = map[string]any{
				"id":           *userID,
				"name":         userName,
				"email":        userEmail,
				"avatar":       userAvatar,
				"phone_number": userPhone,
				"createdAt":    jsTime(userCreatedAt),
			}
		} else {
			app["user"] = nil
		}
		applications = append(applications, app)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	total, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `Doctor` WHERE verificationStatus = ?", status)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	totalPages := 0
	if limit > 0 {
		totalPages = (total + limit - 1) / limit
	}

	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"applications": applications,
			"pagination": map[string]any{
				"page": page, "limit": limit, "total": total, "totalPages": totalPages,
			},
		},
	})
}

/* ------------------------------------------------------------------ *
 * PATCH /admin/doctors/:id/verification
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminDoctorVerification(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fields, ok := s.adminBodyObject(w, r)
	if !ok {
		return
	}
	// UpdateVerificationSchema checks body before params.
	status, ok := s.adminValidateEnumField(w, fields, "status", "body.status",
		"Invalid verification status", "approved", "rejected")
	if !ok {
		return
	}
	doctorID, ok := s.adminParamID(w, r)
	if !ok {
		return
	}

	var (
		doctor    adminDoctorRow
		userID    string
		userName  *string
		userEmail *string
	)
	dest := append(doctor.scanDest(), &userID, &userName, &userEmail)
	err := s.DB.QueryRowContext(ctx,
		"SELECT "+adminDoctorColumns+", u.id, u.name, u.email "+
			"FROM `Doctor` d JOIN `User` u ON u.id = d.userId WHERE d.id = ?", doctorID).
		Scan(dest...)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Doctor not found")
		return
	}
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `Doctor` SET verificationStatus = ?, updatedAt = ? WHERE id = ?",
		status, time.Now().UTC(), doctorID); err != nil {
		s.adminFail(w, r, err)
		return
	}

	updated, err := adminScanDoctor(s.DB.QueryRowContext(ctx,
		"SELECT "+adminDoctorColumns+" FROM `Doctor` d WHERE d.id = ?", doctorID))
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	// The Node cache invalidation has no counterpart: the Go service serves
	// the doctor directory from MySQL with no Redis projection to drop.

	s.audit(ctx, "doctor."+status, &CurrentUser(r).ID, ptr("Doctor"), &doctorID, map[string]any{
		"doctorUserId": doctor.UserID,
	})

	// The Node controller built and sent an approval email here; the Go
	// service has no mailer, so the decision reaches the doctor as an in-app
	// system notification (same preference gate every notification uses).
	notifTitle := "Update on your MindEase application"
	notifMessage := "Thank you for applying to join MindEase. After review, we were unable to approve your profile at this time."
	if status == "approved" {
		notifTitle = "Welcome to MindEase — profile approved"
		notifMessage = "Great news — your psychologist profile has been approved! Patients can now find and book sessions with you."
	}
	if _, err := s.notifCreate(ctx, doctor.UserID, notifTitle, notifMessage, "system", false); err != nil {
		s.Log.Warn("doctor verification notification failed", "doctorId", doctorID, "err", err)
	}

	updatedJSON := updated.JSON()
	updatedJSON["user"] = map[string]any{"id": userID, "email": userEmail, "name": userName}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": updatedJSON})
}

/* ------------------------------------------------------------------ *
 * POST /admin/broadcast
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminBroadcast(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fields, ok := s.adminBodyObject(w, r)
	if !ok {
		return
	}
	title, ok := s.adminValidateStringField(w, fields, "title", "body.title", 255)
	if !ok {
		return
	}
	message, ok := s.adminValidateStringField(w, fields, "message", "body.message", 2000)
	if !ok {
		return
	}
	cleanTitle := strings.TrimSpace(title)
	cleanMessage := strings.TrimSpace(message)
	if cleanTitle == "" || cleanMessage == "" {
		s.Fail(w, http.StatusBadRequest, "Title and message are required")
		return
	}

	// NotificationService.broadcast: one sanitisation at the choke point,
	// every non-banned user whose `system` preference keeps in-app on.
	sanitizedTitle := s.adminSanitize(cleanTitle)
	sanitizedMessage := s.adminSanitize(cleanMessage)

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, notificationPrefs FROM `User` WHERE isBanned = false")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	recipients := []string{}
	for rows.Next() {
		var id string
		var raw sql.NullString
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		prefs := notifParsePrefs(strPtr(raw))
		if channel, _ := prefs.channel("system"); channel.InApp {
			recipients = append(recipients, id)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	// Batched insert, chunked so one statement cannot exceed MySQL's bind
	// parameter ceiling on a large user table. The per-user realtime event and
	// web push from the Node fan-out are not sent by the Go service.
	const adminBroadcastChunk = 500
	for start := 0; start < len(recipients); start += adminBroadcastChunk {
		end := min(start+adminBroadcastChunk, len(recipients))
		values := make([]string, 0, end-start)
		args := make([]any, 0, (end-start)*7)
		now := time.Now().UTC()
		for _, userID := range recipients[start:end] {
			values = append(values, "(?,?,?,?,?,?,?)")
			args = append(args, newID(), userID, sanitizedTitle, sanitizedMessage, false, "system", now)
		}
		if _, err := s.DB.ExecContext(ctx,
			"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES "+
				strings.Join(values, ","), args...); err != nil {
			s.adminFail(w, r, err)
			return
		}
	}

	s.audit(ctx, "admin.broadcast", &CurrentUser(r).ID, ptr("System"), nil, map[string]any{
		"recipients": len(recipients),
		"title":      cleanTitle,
	})

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"recipients": len(recipients),
	}})
}

/* ------------------------------------------------------------------ *
 * GET /admin/audit-logs
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminAuditLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	page := adminJsIntOr(query.Get("page"), 1)
	limit := adminJsIntOr(query.Get("limit"), 20)
	if limit > 50 {
		limit = 50
	}
	skip := (page - 1) * limit

	rows, err := s.DB.QueryContext(ctx,
		"SELECT a.id, a.actorId, a.action, a.targetType, a.targetId, a.meta, a.createdAt, "+
			"u.id, u.name, u.email, u.role "+
			"FROM `AuditLog` a LEFT JOIN `User` u ON u.id = a.actorId "+
			"ORDER BY a.createdAt DESC LIMIT ? OFFSET ?", limit, skip)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	logs := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id         string
			actorID    *string
			action     string
			targetType *string
			targetID   *string
			meta       *string
			createdAt  time.Time
			actorUser  *string
			actorName  *string
			actorEmail *string
			actorRole  *string
		)
		if err := rows.Scan(&id, &actorID, &action, &targetType, &targetID, &meta, &createdAt,
			&actorUser, &actorName, &actorEmail, &actorRole); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		var actor any
		if actorUser != nil {
			actor = map[string]any{
				"id": *actorUser, "name": actorName, "email": actorEmail, "role": actorRole,
			}
		}
		logs = append(logs, map[string]any{
			"id":         id,
			"actorId":    actorID,
			"action":     action,
			"targetType": targetType,
			"targetId":   targetID,
			"meta":       meta,
			"createdAt":  jsTimeValue(createdAt),
			"actor":      actor,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	total, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `AuditLog`")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	totalPages := 0
	if limit > 0 {
		totalPages = (total + limit - 1) / limit
	}

	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"logs": logs, "total": total, "page": page, "limit": limit, "totalPages": totalPages,
		},
	})
}

/* ------------------------------------------------------------------ *
 * GET /admin/audit-logs/patient/:id
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminPatientAccessLog(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	patientID, ok := s.adminParamID(w, r)
	if !ok {
		return
	}

	// AuditService.readsForSubject: the subject id lives inside `meta`, and
	// the take is min(max(limit,1),500) with the admin controller asking 200.
	pattern := `%"subjectId":"` + patientID + `"%`
	rows, err := s.DB.QueryContext(ctx,
		"SELECT a.id, a.actorId, a.targetType, a.targetId, a.meta, a.createdAt, u.name, u.role "+
			"FROM `AuditLog` a LEFT JOIN `User` u ON u.id = a.actorId "+
			"WHERE a.action = 'clinical.read' AND a.meta LIKE ? "+
			"ORDER BY a.createdAt DESC LIMIT 200", pattern)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	entries := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id         string
			actorID    *string
			targetType *string
			targetID   *string
			meta       *string
			createdAt  time.Time
			actorName  *string
			actorRole  *string
		)
		if err := rows.Scan(&id, &actorID, &targetType, &targetID, &meta, &createdAt, &actorName, &actorRole); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		// A malformed `meta` must not hide the access record itself - the read
		// happened whatever the note says.
		var via any
		if meta != nil {
			var parsed map[string]any
			if json.Unmarshal([]byte(*meta), &parsed) == nil {
				if v, present := parsed["via"]; present && v != nil {
					via = v
				}
			}
		}
		entries = append(entries, map[string]any{
			"id":        id,
			"actorId":   actorID,
			"actorName": actorName,
			"actorRole": actorRole,
			"resource":  targetType,
			"targetId":  targetID,
			"via":       via,
			"createdAt": jsTimeValue(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": entries})
}

/* ------------------------------------------------------------------ *
 * GET /admin/review-reports
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminReviewReports(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	page := adminJsIntOr(query.Get("page"), 1)
	limit := adminJsIntOr(query.Get("limit"), 20)
	if limit > 50 {
		limit = 50
	}
	status := query.Get("status")
	if status == "" {
		status = "open"
	}
	skip := (page - 1) * limit

	rows, err := s.DB.QueryContext(ctx,
		"SELECT rr.id, rr.reviewId, rr.reporterId, rr.reason, rr.status, rr.createdAt, "+
			"rv.id, rv.rating, rv.comment, rv.userId, rv.doctorId, rv.appointmentId, rv.reply, rv.repliedAt, rv.hidden, rv.createdAt, "+
			"ru.id, ru.name, "+
			adminDoctorColumns+", du.id, du.name, rep.id, rep.name "+
			"FROM `ReviewReport` rr "+
			"JOIN `Review` rv ON rv.id = rr.reviewId "+
			"JOIN `User` ru ON ru.id = rv.userId "+
			"JOIN `Doctor` d ON d.id = rv.doctorId "+
			"JOIN `User` du ON du.id = d.userId "+
			"JOIN `User` rep ON rep.id = rr.reporterId "+
			"WHERE rr.status = ? ORDER BY rr.createdAt DESC LIMIT ? OFFSET ?", status, limit, skip)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	reports := make([]map[string]any, 0)
	for rows.Next() {
		var (
			reportID    string
			reviewID    string
			reporterID  string
			reason      string
			reportState string
			reportDate  time.Time

			rvID           string
			rvRating       int
			rvComment      string
			rvUserID       string
			rvDoctorID     string
			rvAppointment  *string
			rvReply        *string
			rvRepliedAt    *time.Time
			rvHidden       bool
			rvCreatedAt    time.Time
			rvAuthorID     string
			rvAuthorName   *string
			doctor         adminDoctorRow
			doctorUserID   string
			doctorUserName *string
			reporterName   *string
		)
		dest := []any{
			&reportID, &reviewID, &reporterID, &reason, &reportState, &reportDate,
			&rvID, &rvRating, &rvComment, &rvUserID, &rvDoctorID, &rvAppointment, &rvReply, &rvRepliedAt, &rvHidden, &rvCreatedAt,
			&rvAuthorID, &rvAuthorName,
		}
		dest = append(dest, doctor.scanDest()...)
		dest = append(dest, &doctorUserID, &doctorUserName, &reporterName)
		if err := rows.Scan(dest...); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}

		doctorJSON := doctor.JSON()
		doctorJSON["user"] = map[string]any{"id": doctorUserID, "name": doctorUserName}
		review := map[string]any{
			"id":            rvID,
			"rating":        rvRating,
			"comment":       rvComment,
			"userId":        rvUserID,
			"doctorId":      rvDoctorID,
			"appointmentId": rvAppointment,
			"reply":         rvReply,
			"repliedAt":     jsTime(rvRepliedAt),
			"hidden":        rvHidden,
			"createdAt":     jsTimeValue(rvCreatedAt),
			"user":          map[string]any{"id": rvAuthorID, "name": rvAuthorName},
			"doctor":        doctorJSON,
		}
		reports = append(reports, map[string]any{
			"id":         reportID,
			"reviewId":   reviewID,
			"reporterId": reporterID,
			"reason":     reason,
			"status":     reportState,
			"createdAt":  jsTimeValue(reportDate),
			"review":     review,
			"reporter":   map[string]any{"id": reporterID, "name": reporterName},
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	total, err := s.adminCount(ctx, "SELECT COUNT(*) FROM `ReviewReport` WHERE status = ?", status)
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	totalPages := 0
	if limit > 0 {
		totalPages = (total + limit - 1) / limit
	}

	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"reports": reports, "total": total, "page": page, "totalPages": totalPages,
		},
	})
}

/* ------------------------------------------------------------------ *
 * POST /admin/reviews/:id/hide
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminHideReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	reviewID, ok := s.adminParamID(w, r)
	if !ok {
		return
	}

	var doctorID string
	err := s.DB.QueryRowContext(ctx, "SELECT doctorId FROM `Review` WHERE id = ?", reviewID).Scan(&doctorID)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Review not found")
		return
	}
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	if _, err := s.DB.ExecContext(ctx, "UPDATE `Review` SET hidden = TRUE WHERE id = ?", reviewID); err != nil {
		s.adminFail(w, r, err)
		return
	}

	// Hidden reviews must stop influencing the public average. The Node call
	// is `.catch(() => {})`, so a recalculation failure never fails the hide.
	if err := s.adminRecalcDoctorRating(ctx, doctorID); err != nil {
		s.Log.Warn("doctor rating recalculation failed after hiding a review", "doctorId", doctorID, "err", err)
	}

	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `ReviewReport` SET status = 'resolved' WHERE reviewId = ? AND status = 'open'", reviewID); err != nil {
		s.adminFail(w, r, err)
		return
	}

	s.audit(ctx, "admin.review_hidden", &CurrentUser(r).ID, ptr("Review"), &reviewID, nil)

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"hidden": true}})
}

/* ------------------------------------------------------------------ *
 * POST /admin/review-reports/:id/status
 * ------------------------------------------------------------------ */

func (s *Server) handleAdminResolveReviewReport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fields, ok := s.adminBodyObject(w, r)
	if !ok {
		return
	}
	// ReviewReportStatusSchema checks body before params.
	status, ok := s.adminValidateEnumField(w, fields, "status", "body.status", "Invalid status", "resolved", "dismissed")
	if !ok {
		return
	}
	reportID, ok := s.adminParamID(w, r)
	if !ok {
		return
	}
	if !containsString([]string{"resolved", "dismissed"}, status) {
		s.Fail(w, http.StatusBadRequest, "Status must be resolved or dismissed")
		return
	}

	var reviewID string
	err := s.DB.QueryRowContext(ctx, "SELECT reviewId FROM `ReviewReport` WHERE id = ?", reportID).Scan(&reviewID)
	if err == sql.ErrNoRows {
		s.Fail(w, http.StatusNotFound, "Report not found")
		return
	}
	if err != nil {
		s.adminFail(w, r, err)
		return
	}

	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `ReviewReport` SET status = ? WHERE id = ?", status, reportID); err != nil {
		s.adminFail(w, r, err)
		return
	}

	s.audit(ctx, "admin.report_"+status, &CurrentUser(r).ID, ptr("ReviewReport"), &reportID, map[string]any{
		"reviewId": reviewID,
	})

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"status": status}})
}

/* ------------------------------------------------------------------ *
 * GET /admin/export/:kind - CSV exports
 * ------------------------------------------------------------------ */

func adminISOTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func adminStrOr(p *string, fallback string) string {
	if p == nil || *p == "" {
		return fallback
	}
	return *p
}

// adminJSNullable renders a nullable string the way a JS template literal
// would: `${null}` is "null".
func adminJSNullable(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

// adminCSVEscape is the controller's `escape`: quote when the value contains
// a quote, a comma or a newline, doubling embedded quotes.
func adminCSVEscape(v string) string {
	if strings.ContainsAny(v, "\",\n") {
		return `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
	}
	return v
}

func adminToCSV(rows [][]string) string {
	lines := make([]string, len(rows))
	for i, row := range rows {
		cells := make([]string, len(row))
		for j, cell := range row {
			cells[j] = adminCSVEscape(cell)
		}
		lines[i] = strings.Join(cells, ",")
	}
	return strings.Join(lines, "\n")
}

func (s *Server) adminSendCSV(w http.ResponseWriter, filename, body string) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
}

func (s *Server) handleAdminExport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actorID := CurrentUser(r).ID
	kind := chi.URLParam(r, "kind")

	if kind == "users" {
		rows, err := s.DB.QueryContext(ctx,
			"SELECT id, name, email, role, provider, isBanned, createdAt FROM `User` "+
				"WHERE isBanned = false ORDER BY createdAt DESC LIMIT 10000")
		if err != nil {
			s.adminFail(w, r, err)
			return
		}
		csvRows := [][]string{{"id", "name", "email", "role", "provider", "banned", "createdAt"}}
		for rows.Next() {
			var (
				id        string
				name      *string
				email     string
				role      string
				provider  string
				isBanned  bool
				createdAt time.Time
			)
			if err := rows.Scan(&id, &name, &email, &role, &provider, &isBanned, &createdAt); err != nil {
				rows.Close()
				s.adminFail(w, r, err)
				return
			}
			csvRows = append(csvRows, []string{
				id, adminStrOr(name, ""), email, role, provider,
				strconv.FormatBool(isBanned), adminISOTime(createdAt),
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		rows.Close()

		// Recorded before the response is sent, so a download that happened is
		// a download that was logged.
		s.audit(ctx, "admin.export", &actorID, ptr("Export"), nil, map[string]any{
			"kind": "users", "rows": len(csvRows) - 1,
		})
		s.adminSendCSV(w, "mindease-users.csv", adminToCSV(csvRows))
		return
	}

	if kind == "revenue" {
		type adminRevenueDoctor struct {
			id    string
			price int
			name  *string
		}
		doctors := []adminRevenueDoctor{}
		rows, err := s.DB.QueryContext(ctx,
			"SELECT d.id, d.price, u.name FROM `Doctor` d LEFT JOIN `User` u ON u.id = d.userId ORDER BY d.id ASC")
		if err != nil {
			s.adminFail(w, r, err)
			return
		}
		for rows.Next() {
			var d adminRevenueDoctor
			if err := rows.Scan(&d.id, &d.price, &d.name); err != nil {
				rows.Close()
				s.adminFail(w, r, err)
				return
			}
			doctors = append(doctors, d)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		rows.Close()

		bookingsByDoctor := map[string]int{}
		arows, err := s.DB.QueryContext(ctx,
			"SELECT doctorId, COUNT(*) FROM `Appointment` WHERE status = 'completed' GROUP BY doctorId")
		if err != nil {
			s.adminFail(w, r, err)
			return
		}
		for arows.Next() {
			var doctorID string
			var count int
			if err := arows.Scan(&doctorID, &count); err != nil {
				arows.Close()
				s.adminFail(w, r, err)
				return
			}
			bookingsByDoctor[doctorID] = count
		}
		if err := arows.Err(); err != nil {
			arows.Close()
			s.adminFail(w, r, err)
			return
		}
		arows.Close()

		csvRows := [][]string{{"doctorId", "doctor", "completedBookings", "revenue", "rate"}}
		for _, d := range doctors {
			bookings := bookingsByDoctor[d.id]
			csvRows = append(csvRows, []string{
				d.id, adminStrOr(d.name, "Doctor"),
				strconv.Itoa(bookings), strconv.Itoa(bookings * d.price), strconv.Itoa(d.price),
			})
		}

		s.audit(ctx, "admin.export", &actorID, ptr("Export"), nil, map[string]any{
			"kind": "revenue", "rows": len(csvRows) - 1,
		})
		s.adminSendCSV(w, "mindease-revenue.csv", adminToCSV(csvRows))
		return
	}

	// default: bookings. An unlisted `kind` still returns patient data, which
	// is exactly the case worth recording - the Node fall-through logs it as
	// the bookings dataset.
	rows, err := s.DB.QueryContext(ctx,
		"SELECT a.id, u.name, u.email, du.name, a.appointmentDate, a.startTime, a.endTime, "+
			"a.consultationType, a.status, d.price, a.createdAt "+
			"FROM `Appointment` a "+
			"LEFT JOIN `User` u ON u.id = a.userId "+
			"LEFT JOIN `Doctor` d ON d.id = a.doctorId "+
			"LEFT JOIN `User` du ON du.id = d.userId "+
			"ORDER BY a.createdAt DESC LIMIT 10000")
	if err != nil {
		s.adminFail(w, r, err)
		return
	}
	csvRows := [][]string{{"id", "patient", "patientEmail", "doctor", "date", "time", "type", "status", "price", "createdAt"}}
	for rows.Next() {
		var (
			id               string
			patientName      *string
			patientEmail     *string
			doctorName       *string
			appointmentDate  time.Time
			startTime        *string
			endTime          *string
			consultationType string
			status           string
			price            int
			createdAt        time.Time
		)
		if err := rows.Scan(&id, &patientName, &patientEmail, &doctorName, &appointmentDate,
			&startTime, &endTime, &consultationType, &status, &price, &createdAt); err != nil {
			rows.Close()
			s.adminFail(w, r, err)
			return
		}
		csvRows = append(csvRows, []string{
			id,
			adminStrOr(patientName, "Patient"),
			adminStrOr(patientEmail, ""),
			adminStrOr(doctorName, "Doctor"),
			appointmentDate.UTC().Format("2006-01-02"),
			adminJSNullable(startTime) + "–" + adminJSNullable(endTime),
			consultationType,
			status,
			strconv.Itoa(price),
			adminISOTime(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.adminFail(w, r, err)
		return
	}
	rows.Close()

	s.audit(ctx, "admin.export", &actorID, ptr("Export"), nil, map[string]any{
		"kind": "bookings", "rows": len(csvRows) - 1,
	})
	s.adminSendCSV(w, "mindease-bookings.csv", adminToCSV(csvRows))
}
