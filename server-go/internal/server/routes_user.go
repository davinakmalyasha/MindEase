package server

import (
	"context"
	"database/sql"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// registerUser is the port of routes/user.routes.ts: the authenticated user
// routes. This port implements the profile read; the multipart profile update
// is out of scope for this domain's endpoint list.
func (s *Server) registerUser(api chi.Router) {
	api.With(s.authenticate).Get("/users/profile", s.handleUserGetProfile)
}

func (s *Server) handleUserGetProfile(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	profile, err := s.userGetProfile(r.Context(), user.ID)
	if err != nil {
		s.Log.Error("get profile failed", "err", err, "userId", user.ID)
		s.Fail(w, http.StatusInternalServerError, "Something went wrong. Please try again.")
		return
	}
	if profile == nil {
		s.Fail(w, http.StatusNotFound, "Profile not found")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": profile})
}

// userGetProfile is UserService.getProfile's select, including the whole
// doctor profile, with the lazy referral-code assignment for accounts created
// before the feature shipped.
func (s *Server) userGetProfile(ctx context.Context, userID string) (map[string]any, error) {
	var (
		id, email, role, provider string
		name, avatar, phoneNumber sql.NullString
		referralCode, timezone    sql.NullString
		createdAt                 time.Time
		weeklyReportEnabled       bool
		sessionCredits            int
		totpEnabled, isVerified   bool

		doctorID, doctorUserID              sql.NullString
		specialty, bio, availability        sql.NullString
		verificationStatus, licenseNumber   sql.NullString
		licenseIssuer, languages, education sql.NullString
		bankName, bankAccount, bankHolder   sql.NullString
		experience, totalReviews, price     sql.NullInt64
		rating                              sql.NullFloat64
		awayUntil                           sql.NullTime
		doctorCreatedAt, doctorUpdatedAt    sql.NullTime
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT u.id, u.email, u.name, u.avatar, u.role, u.phone_number, u.provider, u.createdAt, "+
			"u.weeklyReportEnabled, u.referralCode, u.sessionCredits, u.totpEnabled, u.isVerified, u.timezone, "+
			"d.id, d.userId, d.specialty, d.bio, d.experience, d.rating, d.totalReviews, d.languages, d.education, "+
			"d.price, d.bankName, d.bankAccount, d.bankHolder, d.availability, d.verificationStatus, d.licenseNumber, "+
			"d.licenseIssuer, d.awayUntil, d.createdAt, d.updatedAt "+
			"FROM `User` u LEFT JOIN `Doctor` d ON d.userId = u.id WHERE u.id = ?", userID).Scan(
		&id, &email, &name, &avatar, &role, &phoneNumber, &provider, &createdAt,
		&weeklyReportEnabled, &referralCode, &sessionCredits, &totpEnabled, &isVerified, &timezone,
		&doctorID, &doctorUserID, &specialty, &bio, &experience, &rating, &totalReviews, &languages, &education,
		&price, &bankName, &bankAccount, &bankHolder, &availability, &verificationStatus, &licenseNumber,
		&licenseIssuer, &awayUntil, &doctorCreatedAt, &doctorUpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Lazily assign a referral code to accounts created before the feature.
	if !referralCode.Valid || referralCode.String == "" {
		code := newReferralCode()
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET referralCode = ?, updatedAt = ? WHERE id = ?",
			code, time.Now().UTC(), userID); err != nil {
			return nil, err
		}
		referralCode = sql.NullString{String: code, Valid: true}
	}

	var doctorProfile any
	if doctorID.Valid {
		doctorProfile = map[string]any{
			"id":                 doctorID.String,
			"userId":             doctorUserID.String,
			"specialty":          specialty.String,
			"bio":                bio.String,
			"experience":         int(experience.Int64),
			"rating":             rating.Float64,
			"totalReviews":       int(totalReviews.Int64),
			"languages":          strPtr(languages),
			"education":          strPtr(education),
			"price":              int(price.Int64),
			"bankName":           strPtr(bankName),
			"bankAccount":        strPtr(bankAccount),
			"bankHolder":         strPtr(bankHolder),
			"availability":       availability.String,
			"verificationStatus": verificationStatus.String,
			"licenseNumber":      strPtr(licenseNumber),
			"licenseIssuer":      strPtr(licenseIssuer),
			"awayUntil":          jsTime(accountTimePtr(awayUntil)),
			"createdAt":          jsTimeValue(doctorCreatedAt.Time),
			"updatedAt":          jsTimeValue(doctorUpdatedAt.Time),
		}
	}

	return map[string]any{
		"id":                  id,
		"email":               email,
		"name":                strPtr(name),
		"avatar":              strPtr(avatar),
		"role":                role,
		"phone_number":        strPtr(phoneNumber),
		"provider":            provider,
		"createdAt":           jsTimeValue(createdAt),
		"weeklyReportEnabled": weeklyReportEnabled,
		"referralCode":        strPtr(referralCode),
		"sessionCredits":      sessionCredits,
		"totpEnabled":         totpEnabled,
		"isVerified":          isVerified,
		"timezone":            strPtr(timezone),
		"doctorProfile":       doctorProfile,
	}, nil
}
