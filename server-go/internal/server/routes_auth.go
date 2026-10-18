package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// registerAuth ports routes/auth.routes.ts and services/auth.service.ts.
func (s *Server) registerAuth(api chi.Router) {
	authRate := s.limiter(rateLimitConfig{
		name:           "auth",
		window:         15 * time.Minute,
		max:            20,
		skipSuccessful: true,
		message:        "Too many login attempts, please try again after 15 minutes",
	})
	api.With(authRate).Post("/auth/register", s.handleRegister)
	api.With(authRate).Post("/auth/login", s.handleLogin)
	api.With(authRate).Post("/auth/google", s.handleGoogle)
	api.With(authRate).Post("/auth/refresh", s.handleRefresh)
	api.Post("/auth/logout", s.handleLogout)
}

type tokenPair struct {
	AccessToken  string
	RefreshToken string
}

func (s *Server) generateTokens(u *UserRow, amr []string) (tokenPair, error) {
	if len(amr) == 0 {
		amr = []string{"pwd"}
	}
	totpVerified := !u.TotpEnabled || containsString(amr, "otp")
	access, err := s.signAccessToken(u.ID, u.Role, totpVerified)
	if err != nil {
		return tokenPair{}, err
	}
	refresh, err := s.signRefreshToken(u.ID, amr)
	if err != nil {
		return tokenPair{}, err
	}
	return tokenPair{AccessToken: access, RefreshToken: refresh}, nil
}

// storeRefreshToken persists only the SHA-256 digest, prunes expired rows and
// keeps at most five active sessions per user, like AuthService.
func (s *Server) storeRefreshToken(ctx context.Context, userID, token string) error {
	_, err := s.DB.ExecContext(ctx, "DELETE FROM `RefreshToken` WHERE userId = ? AND expiresAt < ?", userID, time.Now().UTC())
	if err != nil {
		return err
	}
	var active int
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM `RefreshToken` WHERE userId = ?", userID).Scan(&active); err != nil {
		return err
	}
	if active >= 5 {
		_, err = s.DB.ExecContext(ctx, "DELETE FROM `RefreshToken` WHERE userId = ? ORDER BY createdAt ASC LIMIT ?", userID, active-4)
		if err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `RefreshToken` (id, tokenHash, userId, createdAt, expiresAt) VALUES (?,?,?,?,?)",
		newID(), hashToken(token), userID, now, now.Add(7*24*time.Hour))
	return err
}

func (s *Server) revokeAllSessions(ctx context.Context, userID, reason string) int64 {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM `RefreshToken` WHERE userId = ?", userID)
	if err != nil {
		return 0
	}
	count, _ := res.RowsAffected()
	if count > 0 {
		s.audit(ctx, "auth.sessions_revoked", &userID, nil, nil, map[string]any{"reason": reason, "revoked": count})
	}
	return count
}

func newReferralCode() string {
	raw := make([]byte, 4)
	_, _ = rand.Read(raw)
	return "ME-" + strings.ToUpper(hex.EncodeToString(raw))
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email        string  `json:"email"`
		Password     string  `json:"password"`
		Name         string  `json:"name"`
		PhoneNumber  *string `json:"phone_number"`
		Role         string  `json:"role"`
		ReferralCode *string `json:"referralCode"`
	}
	if err := DecodeJSON(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if msg := emailError(strings.TrimSpace(body.Email)); msg != "" {
		s.validationFail(w, "body.email", msg)
		return
	}
	if msg := passwordError(body.Password); msg != "" {
		s.validationFail(w, "body.password", msg)
		return
	}
	if msg := requiredLen(body.Name, 120, "Name must be at least 1 character", "Must be 120 characters or fewer"); msg != "" {
		s.validationFail(w, "body.name", msg)
		return
	}
	if body.PhoneNumber != nil {
		phone := strings.TrimSpace(*body.PhoneNumber)
		if len(phone) < 8 {
			s.validationFail(w, "body.phone_number", "Phone number must be at least 8 characters")
			return
		}
		if len(phone) > 20 {
			s.validationFail(w, "body.phone_number", "Phone number must be at most 20 characters")
			return
		}
	}
	if body.Role == "" {
		body.Role = "patient"
	}
	if body.Role != "patient" && body.Role != "doctor" {
		s.validationFail(w, "body.role", "Invalid option")
		return
	}
	if body.ReferralCode != nil {
		code := strings.TrimSpace(*body.ReferralCode)
		if len(code) < 4 || len(code) > 20 {
			s.validationFail(w, "body.referralCode", "Must be 20 characters or fewer")
			return
		}
	}

	email := strings.TrimSpace(body.Email)
	if _, err := s.userByEmail(r.Context(), email); err == nil {
		s.Fail(w, http.StatusBadRequest, "Email already registered")
		return
	} else if err != sql.ErrNoRows {
		s.AppErr(w, r, err)
		return
	}

	hashed, err := hashPassword(body.Password)
	if err != nil {
		s.AppErr(w, r, err)
		return
	}
	userID := newID()
	now := time.Now().UTC()
	referralCode := newReferralCode()
	_, err = s.DB.ExecContext(r.Context(),
		"INSERT INTO `User` (id, email, password, name, role, phone_number, provider, isVerified, referralCode, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		userID, email, hashed, strings.TrimSpace(body.Name), body.Role, body.PhoneNumber, "local", false, referralCode, now, now)
	if err != nil {
		s.Log.Error("register insert failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}

	if body.ReferralCode != nil {
		code := strings.ToUpper(strings.TrimSpace(*body.ReferralCode))
		var referrerID string
		err := s.DB.QueryRowContext(r.Context(),
			"SELECT id FROM `User` WHERE referralCode = ? AND id <> ? LIMIT 1", code, userID).Scan(&referrerID)
		if err == nil {
			_, _ = s.DB.ExecContext(r.Context(),
				"INSERT INTO `Referral` (id, referrerId, referredId, code, status, createdAt) VALUES (?,?,?,?,?,?)",
				newID(), referrerID, userID, code, "pending", time.Now().UTC())
		}
	}

	if body.Role == "doctor" {
		_, err = s.DB.ExecContext(r.Context(),
			"INSERT INTO `Doctor` (id, userId, specialty, bio, verificationStatus, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
			newID(), userID, "General Psychologist",
			"Experienced mental health professional. Complete your profile to get started.",
			"pending", now, now)
		if err != nil {
			s.Log.Error("doctor profile insert failed", "err", err)
		}
	}

	user, err := s.userByID(r.Context(), userID)
	if err != nil {
		s.AppErr(w, r, err)
		return
	}
	tokens, err := s.generateTokens(user, nil)
	if err != nil {
		s.AppErr(w, r, err)
		return
	}
	if err := s.storeRefreshToken(r.Context(), user.ID, tokens.RefreshToken); err != nil {
		s.AppErr(w, r, err)
		return
	}
	setSessionCookies(w, s.Cfg.IsProd, tokens.AccessToken, tokens.RefreshToken)
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": map[string]any{"user": user.Safe()}})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := DecodeJSON(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if msg := emailError(strings.TrimSpace(body.Email)); msg != "" {
		s.validationFail(w, "body.email", msg)
		return
	}
	if body.Password == "" || len(body.Password) > 200 {
		s.validationFail(w, "body.password", "Password is required")
		return
	}

	// The per-account limiter is applied after parsing because its key is the
	// email (or the pending 2FA token), which the middleware cannot see
	// without consuming the body.
	email := strings.TrimSpace(body.Email)
	if !s.Cfg.IsTest {
		count, _ := s.bump("account", strings.ToLower(email), 15*time.Minute, 1)
		if count > 10 {
			s.Fail(w, http.StatusTooManyRequests, "Too many attempts for this account, please try again after 15 minutes")
			return
		}
	}

	user, err := s.userByEmail(r.Context(), email)
	hash := dummyPasswordHash
	if user != nil && user.Password != nil {
		hash = *user.Password
	}
	validPassword := verifyPassword(body.Password, hash)

	if user == nil || user.Password == nil {
		s.Fail(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	if !validPassword {
		if !user.IsBanned {
			s.recordFailedAttempt(r.Context(), user.ID)
		}
		s.Fail(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	if user.IsBanned {
		s.Fail(w, http.StatusBadRequest, "Account suspended. Contact support.")
		return
	}
	if user.LockedUntil != nil && user.LockedUntil.After(time.Now().UTC()) {
		s.Fail(w, http.StatusBadRequest, "Account temporarily locked due to too many failed attempts. Try again later.")
		return
	}
	if user.FailedAttempts > 0 || user.LockedUntil != nil {
		_, _ = s.DB.ExecContext(r.Context(),
			"UPDATE `User` SET failedAttempts = 0, lockedUntil = NULL, updatedAt = ? WHERE id = ?", time.Now().UTC(), user.ID)
	}
	s.audit(r.Context(), "auth.login", &user.ID, nil, nil, map[string]any{"provider": "local"})

	if user.TotpEnabled {
		ticket, err := s.signTwoFactorToken(user.ID)
		if err != nil {
			s.AppErr(w, r, err)
			return
		}
		s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
			"requires2FA":    true,
			"twoFactorToken": ticket,
			"user":           user.Safe(),
		}})
		return
	}

	tokens, err := s.generateTokens(user, nil)
	if err != nil {
		s.AppErr(w, r, err)
		return
	}
	if err := s.storeRefreshToken(r.Context(), user.ID, tokens.RefreshToken); err != nil {
		s.AppErr(w, r, err)
		return
	}
	setSessionCookies(w, s.Cfg.IsProd, tokens.AccessToken, tokens.RefreshToken)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"user": user.Safe()}})
}

// recordFailedAttempt increments with SQL arithmetic and stamps the lock only
// when no lock is in force, so a hammering attacker cannot push the expiry
// forward forever.
func (s *Server) recordFailedAttempt(ctx context.Context, userID string) {
	_, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET failedAttempts = failedAttempts + 1, updatedAt = ? WHERE id = ?", time.Now().UTC(), userID)
	if err != nil {
		return
	}
	var failed int
	var lockedUntil *time.Time
	err = s.DB.QueryRowContext(ctx,
		"SELECT failedAttempts, lockedUntil FROM `User` WHERE id = ?", userID).Scan(&failed, &lockedUntil)
	if err != nil {
		return
	}
	if lockedUntil != nil && lockedUntil.After(time.Now().UTC()) {
		return
	}
	if failed >= 5 {
		_, _ = s.DB.ExecContext(ctx,
			"UPDATE `User` SET lockedUntil = ?, updatedAt = ? WHERE id = ?",
			time.Now().UTC().Add(15*time.Minute), time.Now().UTC(), userID)
	}
}

// googleTokenInfo verifies an ID token at Google's tokeninfo endpoint. It
// checks audience and verified email, which is what the Node flow relies on.
func (s *Server) googleTokenInfo(ctx context.Context, idToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://oauth2.googleapis.com/tokeninfo?id_token="+url.QueryEscape(idToken), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, BadRequest("Invalid Google Token")
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, BadRequest("Invalid Google Token")
	}
	return payload, nil
}

func (s *Server) handleGoogle(w http.ResponseWriter, r *http.Request) {
	if s.Cfg.GoogleClientID == "" {
		s.Fail(w, http.StatusBadRequest, "Google sign-in is not configured on the server")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := DecodeJSON(r, &body); err != nil || body.Token == "" || len(body.Token) > 4096 {
		s.validationFail(w, "body.token", "Google token is required")
		return
	}

	payload, err := s.googleTokenInfo(r.Context(), body.Token)
	if err != nil {
		s.Fail(w, http.StatusBadRequest, "Invalid Google Token")
		return
	}
	if aud, _ := payload["aud"].(string); aud != s.Cfg.GoogleClientID {
		s.Fail(w, http.StatusBadRequest, "Invalid Google Token")
		return
	}
	email, _ := payload["email"].(string)
	if email == "" {
		s.Fail(w, http.StatusBadRequest, "Invalid Google Token")
		return
	}
	verified := false
	switch v := payload["email_verified"].(type) {
	case bool:
		verified = v
	case string:
		verified = v == "true"
	}
	if !verified {
		s.Fail(w, http.StatusBadRequest, "Google account email is not verified")
		return
	}

	user, err := s.userByEmail(r.Context(), email)
	if err != nil && err != sql.ErrNoRows {
		s.AppErr(w, r, err)
		return
	}
	if user != nil && user.IsBanned {
		s.Fail(w, http.StatusBadRequest, "Account suspended. Contact support.")
		return
	}

	sub, _ := payload["sub"].(string)
	name, _ := payload["name"].(string)
	picture, _ := payload["picture"].(string)
	now := time.Now().UTC()

	if user == nil {
		if name == "" {
			name = strings.Split(email, "@")[0]
		}
		userID := newID()
		_, err = s.DB.ExecContext(r.Context(),
			"INSERT INTO `User` (id, email, name, avatar, googleId, provider, isVerified, referralCode, createdAt, updatedAt) "+
				"VALUES (?,?,?,?,?,?,?,?,?,?)",
			userID, email, name, picture, sub, "google", true, newReferralCode(), now, now)
		if err != nil {
			s.Log.Error("google user insert failed", "err", err)
			s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
			return
		}
		if user, err = s.userByID(r.Context(), userID); err != nil {
			s.AppErr(w, r, err)
			return
		}
	} else if user.GoogleID == nil {
		avatar := picture
		if avatar == "" && user.Avatar != nil {
			avatar = *user.Avatar
		}
		_, _ = s.DB.ExecContext(r.Context(),
			"UPDATE `User` SET googleId = ?, avatar = ?, updatedAt = ? WHERE id = ?", sub, avatar, now, user.ID)
		if user, err = s.userByID(r.Context(), user.ID); err != nil {
			s.AppErr(w, r, err)
			return
		}
	}

	s.audit(r.Context(), "auth.login", &user.ID, nil, nil, map[string]any{"provider": "google"})

	if user.TotpEnabled {
		ticket, err := s.signTwoFactorToken(user.ID)
		if err != nil {
			s.AppErr(w, r, err)
			return
		}
		s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
			"requires2FA":    true,
			"twoFactorToken": ticket,
			"user":           user.Safe(),
		}})
		return
	}

	tokens, err := s.generateTokens(user, []string{"google"})
	if err != nil {
		s.AppErr(w, r, err)
		return
	}
	if err := s.storeRefreshToken(r.Context(), user.ID, tokens.RefreshToken); err != nil {
		s.AppErr(w, r, err)
		return
	}
	setSessionCookies(w, s.Cfg.IsProd, tokens.AccessToken, tokens.RefreshToken)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"user": user.Safe()}})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("refreshToken")
	if err != nil || cookie.Value == "" {
		s.JSON(w, http.StatusUnauthorized, map[string]any{"message": "No refresh token"})
		return
	}
	token := cookie.Value

	claims, err := s.verifyToken(token, purposeRefresh)
	if err != nil {
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}
	userID, _ := claims["userId"].(string)

	var storedID string
	var expiresAt time.Time
	err = s.DB.QueryRowContext(r.Context(),
		"SELECT id, expiresAt FROM `RefreshToken` WHERE tokenHash = ?", hashToken(token)).Scan(&storedID, &expiresAt)
	if err == sql.ErrNoRows {
		// Cryptographically valid but unknown: rotated already or revoked.
		// Treat it as theft and revoke every session for the account.
		res, delErr := s.DB.ExecContext(r.Context(), "DELETE FROM `RefreshToken` WHERE userId = ?", userID)
		var revoked int64
		if delErr == nil {
			revoked, _ = res.RowsAffected()
		}
		s.audit(r.Context(), "auth.refresh_reuse_detected", &userID, nil, nil, map[string]any{"reason": "unknown_token", "revoked": revoked})
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}
	if err != nil {
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}
	if expiresAt.Before(time.Now().UTC()) {
		_, _ = s.DB.ExecContext(r.Context(), "DELETE FROM `RefreshToken` WHERE id = ?", storedID)
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}

	_, _ = s.DB.ExecContext(r.Context(), "DELETE FROM `RefreshToken` WHERE id = ?", storedID)

	user, err := s.userByID(r.Context(), userID)
	if err != nil || user.IsBanned {
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}

	var amr []string
	if raw, ok := claims["amr"].([]any); ok {
		for _, item := range raw {
			if s, ok := item.(string); ok {
				amr = append(amr, s)
			}
		}
	}
	if len(amr) == 0 {
		amr = []string{"pwd"}
	}
	if user.TotpEnabled && !containsString(amr, "otp") {
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}

	tokens, err := s.generateTokens(user, amr)
	if err != nil || s.storeRefreshToken(r.Context(), user.ID, tokens.RefreshToken) != nil {
		clearSessionCookies(w, s.Cfg.IsProd)
		s.Fail(w, http.StatusForbidden, "Invalid refresh token")
		return
	}
	setSessionCookies(w, s.Cfg.IsProd, tokens.AccessToken, tokens.RefreshToken)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success"})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("refreshToken"); err == nil && cookie.Value != "" {
		_, _ = s.DB.ExecContext(r.Context(), "DELETE FROM `RefreshToken` WHERE tokenHash = ?", hashToken(cookie.Value))
	}
	clearSessionCookies(w, s.Cfg.IsProd)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "message": "Logged out"})
}
