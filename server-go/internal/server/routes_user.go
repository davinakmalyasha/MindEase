package server

import (
	"context"
	"database/sql"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// registerUser is the port of routes/user.routes.ts: the authenticated user
// routes, profile read and multipart profile update.
func (s *Server) registerUser(api chi.Router) {
	api.With(s.authenticate).Get("/users/profile", s.handleUserGetProfile)
	api.With(s.authenticate).Put("/users/profile", s.handleUserUpdateProfile)
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

// handleUserUpdateProfile ports the multipart profile update the dashboard
// profile page submits: name, phone, an avatar file, the patient
// weekly-report opt-in, and the doctor practice fields (bio, specialty, price,
// licence, experience, languages, education). Verification status is left
// untouched: editing a bio must not silently unlist an approved clinician,
// and a pending one still needs an admin review.
func (s *Server) handleUserUpdateProfile(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	ctx := r.Context()

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		s.validationFail(w, "body", "Expected a multipart form")
		return
	}
	var values map[string][]string
	if r.MultipartForm != nil {
		values = r.MultipartForm.Value
	}
	value := func(key string) string {
		vals := values[key]
		if len(vals) == 0 {
			return ""
		}
		return strings.TrimSpace(vals[0])
	}

	name := s.apptSanitizeClip(value("name"), 100)
	if name == "" {
		s.validationFail(w, "body.name", "Name is required")
		return
	}
	phone := s.apptSanitizeClip(value("phone_number"), 30)

	weeklyReport := false
	if raw := value("weeklyReportEnabled"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			s.validationFail(w, "body.weeklyReportEnabled", "Invalid input: expected true or false")
			return
		}
		weeklyReport = parsed
	}

	avatarURL := ""
	if r.MultipartForm != nil {
		files := r.MultipartForm.File["avatar"]
		if len(files) > 0 {
			url, msg := s.userSaveAvatar(ctx, files[0])
			if msg != "" {
				s.validationFail(w, "body.avatar", msg)
				return
			}
			avatarURL = url
		}
	}

	now := time.Now().UTC()
	if avatarURL != "" {
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET name = ?, phone_number = ?, avatar = ?, weeklyReportEnabled = ?, updatedAt = ? WHERE id = ?",
			name, emptyToNil(phone), avatarURL, weeklyReport, now, user.ID); err != nil {
			s.Log.Error("profile update failed", "err", err, "userId", user.ID)
			s.Fail(w, http.StatusInternalServerError, "Failed to update profile.")
			return
		}
	} else {
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET name = ?, phone_number = ?, weeklyReportEnabled = ?, updatedAt = ? WHERE id = ?",
			name, emptyToNil(phone), weeklyReport, now, user.ID); err != nil {
			s.Log.Error("profile update failed", "err", err, "userId", user.ID)
			s.Fail(w, http.StatusInternalServerError, "Failed to update profile.")
			return
		}
	}

	if user.Role == "doctor" {
		if msg := s.userUpdateDoctorProfile(ctx, user.ID, value, now); msg != "" {
			s.validationFail(w, "body", msg)
			return
		}
	}

	profile, err := s.userGetProfile(ctx, user.ID)
	if err != nil {
		s.Log.Error("profile read-back failed", "err", err, "userId", user.ID)
		s.Fail(w, http.StatusInternalServerError, "Failed to update profile.")
		return
	}
	s.audit(ctx, "profile.updated", &user.ID, nil, nil, map[string]any{"role": user.Role})
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"user": profile}})
}

// userSaveAvatar validates one avatar upload and stores it through the shared
// upload layer (S3 when configured, the local uploads directory otherwise).
func (s *Server) userSaveAvatar(ctx context.Context, file *multipart.FileHeader) (string, string) {
	if file.Size > 5*1024*1024 {
		return "", "File too large: avatars are limited to 5 MB"
	}
	src, err := file.Open()
	if err != nil {
		return "", "Could not read the uploaded file"
	}
	defer src.Close()
	data, err := io.ReadAll(io.LimitReader(src, 5*1024*1024+1))
	if err != nil {
		return "", "Could not read the uploaded file"
	}
	if len(data) > 5*1024*1024 {
		return "", "File too large: avatars are limited to 5 MB"
	}
	if !strings.HasPrefix(http.DetectContentType(data), "image/") {
		return "", "Avatars must be an image file"
	}
	url, err := s.msgSaveUpload(ctx, data, file.Filename)
	if err != nil {
		s.Log.Error("avatar store failed", "err", err)
		return "", "Could not store the avatar"
	}
	return url, ""
}

// userUpdateDoctorProfile writes the doctor practice fields from the profile
// form. `get` reads the already-trimmed form values. It returns a
// machine-readable failure message, or "" on success.
func (s *Server) userUpdateDoctorProfile(ctx context.Context, userID string, get func(string) string, now time.Time) string {
	var doctorID string
	if err := s.DB.QueryRowContext(ctx,
		"SELECT id FROM `Doctor` WHERE userId = ?", userID).Scan(&doctorID); err != nil {
		if err == sql.ErrNoRows {
			return "No doctor profile exists for this account"
		}
		s.Log.Error("doctor profile lookup failed", "err", err, "userId", userID)
		return "Failed to update profile."
	}

	price := 0
	if raw := get("price"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > 100000000 {
			return "Price must be a whole number of rupiah between 0 and 100000000"
		}
		price = parsed
	}
	experience := 0
	if raw := get("experience"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > 80 {
			return "Experience must be a whole number of years between 0 and 80"
		}
		experience = parsed
	}

	bio := s.apptSanitizeClip(get("bio"), 2000)
	specialty := s.apptSanitizeClip(get("specialty"), 120)
	licenseNumber := s.apptSanitizeClip(get("licenseNumber"), 191)
	licenseIssuer := s.apptSanitizeClip(get("licenseIssuer"), 191)
	languages := s.apptSanitizeClip(get("languages"), 191)
	education := s.apptSanitizeClip(get("education"), 2000)

	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `Doctor` SET bio = ?, specialty = ?, price = ?, licenseNumber = ?, licenseIssuer = ?, "+
			"experience = ?, languages = ?, education = ?, updatedAt = ? WHERE id = ?",
		emptyToNil(bio), emptyToNil(specialty), price,
		emptyToNil(licenseNumber), emptyToNil(licenseIssuer),
		experience, emptyToNil(languages), emptyToNil(education), now, doctorID); err != nil {
		s.Log.Error("doctor profile update failed", "err", err, "userId", userID)
		return "Failed to update profile."
	}
	return ""
}

// emptyToNil stores NULL rather than an empty string, so "cleared" and
// "never set" read the same on the way back out.
func emptyToNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}
