package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/pquerna/otp/totp"
	"github.com/skip2/go-qrcode"
)

// registerAccount is the port of routes/account.routes.ts and the account /
// two-factor controllers and services.
func (s *Server) registerAccount(api chi.Router) {
	// Password reset and 2FA get their own buckets rather than sharing login's,
	// so twenty anonymous attempts cannot deny a victim the ability to sign in,
	// reset a password, or complete a second factor.
	resetRate := s.limiter(rateLimitConfig{
		name:    "reset",
		window:  15 * time.Minute,
		max:     10,
		message: "Too many attempts, please try again after 15 minutes",
	})
	twoFactorRate := s.limiter(rateLimitConfig{
		name:    "twoFactor",
		window:  15 * time.Minute,
		max:     10,
		message: "Too many verification attempts, please try again after 15 minutes",
	})

	// Public routes. The per-account limiter is applied inside the handlers via
	// s.bump("account", ...) because its key lives in the body.
	api.With(resetRate).Post("/account/forgot-password", s.handleAccountForgotPassword)
	api.With(resetRate).Post("/account/reset-password", s.handleAccountResetPassword)
	api.With(resetRate).Post("/account/verify-email", s.handleAccountVerifyEmail)
	api.With(resetRate).Post("/account/resend-verification", s.handleAccountResendVerification)
	api.With(twoFactorRate).Post("/account/2fa/verify", s.handleAccountTwoFactorVerify)

	// Authenticated routes.
	api.Group(func(authed chi.Router) {
		authed.Use(s.authenticate)
		authed.Post("/account/change-password", s.handleAccountChangePassword)
		authed.Delete("/account/me", s.handleAccountDelete)
		authed.Get("/account/export", s.handleAccountExport)
		authed.Post("/account/2fa/setup", s.handleAccountTwoFactorSetup)
		authed.Post("/account/2fa/enable", s.handleAccountTwoFactorEnable)
		authed.Post("/account/2fa/disable", s.handleAccountTwoFactorDisable)
	})
}

const (
	accountOtpTTL         = 10 * time.Minute
	accountMaxOtpAttempts = 5
	accountAppName        = "MindEase"
	accountRateMessage    = "Too many attempts for this account, please try again after 15 minutes"
)

/* ------------------------------------------------------------------ *
 * Shared helpers (all names account-prefixed; one package)
 * ------------------------------------------------------------------ */

// accountDecodeBody mirrors the validate middleware's strict object parse: an
// absent body behaves like `{}`, and an unknown key is a validation failure.
func accountDecodeBody(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	return nil
}

// accountFail mirrors `publicMessageFor(error) ?? {message, status}`: a typed
// domain error keeps its status and message, anything else is a generic
// failure the controller would have produced.
func (s *Server) accountFail(w http.ResponseWriter, err error, fallbackStatus int, fallbackMessage string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("account handler error", "err", err)
	s.Fail(w, fallbackStatus, fallbackMessage)
}

// accountRateLimited applies the per-account limiter (max 10 / 15 minutes) that
// the route middleware cannot key because the key is in the body.
func (s *Server) accountRateLimited(r *http.Request, email, token string) bool {
	if s.Cfg.IsTest {
		return false
	}
	key := "ip:" + remoteIP(r, s.Cfg.IsProd)
	if e := strings.ToLower(strings.TrimSpace(email)); e != "" {
		key = e
	} else if t := strings.TrimSpace(token); t != "" {
		key = "2fa:" + t
	}
	count, _ := s.bump("account", key, 15*time.Minute, 1)
	return count > 10
}

// accountTimePtr converts a nullable DATETIME scan target into the pointer the
// JSON helpers expect.
func accountTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time
	return &t
}

/* ------------------------------------------------------------------ *
 * OTP email (mailer.service.ts)
 * ------------------------------------------------------------------ */

func accountGenerateOtp() (string, error) {
	// crypto.randomInt(100000, 999999): uniform on [100000, 999999).
	n, err := rand.Int(rand.Reader, big.NewInt(899999))
	if err != nil {
		return "", err
	}
	return strconv.FormatInt(n.Int64()+100000, 10), nil
}

// accountForLog scrubs a user-controlled value before it reaches a log line,
// like the mailer's `forLog`: no control characters and bounded length.
func accountForLog(v string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, v)
	if len(cleaned) > 200 {
		return cleaned[:200] + "..."
	}
	return cleaned
}

// accountSendOtp delivers a one-time code over SMTP when configured. Without
// SMTP the Node behavior is kept: production error (which the callers
// deliberately swallow), development log carrying the code.
func (s *Server) accountSendOtp(ctx context.Context, to, purpose, otp string) error {
	subject, html := mailOtpTemplate(purpose, otp)
	if os.Getenv("SMTP_HOST") == "" {
		if s.Cfg.IsProd {
			return errors.New("SMTP is not configured (SMTP_HOST missing) but NODE_ENV=production. " +
				"Password reset and email verification are disabled.")
		}
		s.Log.Warn("[MAIL] SMTP not configured; no message was sent. Code above, if any.",
			"to", accountForLog(to), "subject", accountForLog(subject),
			"devCode", accountForLog(otp), "devFallback", true)
		return nil
	}
	if err := s.mailSend(ctx, to, subject, html); err != nil {
		s.Log.Error("[MAIL] OTP delivery failed", "to", accountForLog(to), "err", err)
		return err
	}
	return nil
}

/* ------------------------------------------------------------------ *
 * POST /account/change-password
 * ------------------------------------------------------------------ */

func (s *Server) accountChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	user, err := s.userByID(ctx, userID)
	if err == sql.ErrNoRows {
		return NotFound("User not found")
	}
	if err != nil {
		return err
	}
	if user.Provider == "google" && user.Password == nil {
		return BadRequest("This account uses Google sign-in and has no local password.")
	}
	hash := ""
	if user.Password != nil {
		hash = *user.Password
	}
	if !verifyPassword(currentPassword, hash) {
		return BadRequest("Current password is incorrect")
	}
	hashed, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET password = ?, resetOtpHash = NULL, resetOtpExpiresAt = NULL, resetOtpAttempts = 0, updatedAt = ? WHERE id = ?",
		hashed, now, userID); err != nil {
		return err
	}
	// A password change must evict sessions an attacker may already hold.
	s.revokeAllSessions(ctx, userID, "password_changed")
	s.audit(ctx, "user.password_changed", &userID, nil, nil, nil)
	return nil
}

func (s *Server) handleAccountChangePassword(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if body.CurrentPassword == "" || len(body.CurrentPassword) > 200 {
		s.validationFail(w, "body.currentPassword", "Current password is required")
		return
	}
	if msg := passwordError(body.NewPassword); msg != "" {
		s.validationFail(w, "body.newPassword", msg)
		return
	}
	if err := s.accountChangePassword(r.Context(), user.ID, body.CurrentPassword, body.NewPassword); err != nil {
		s.accountFail(w, err, http.StatusBadRequest, "Failed to change password.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data":   map[string]any{"success": true, "sessionsRevoked": true},
	})
}

/* ------------------------------------------------------------------ *
 * POST /account/forgot-password, /account/reset-password
 * ------------------------------------------------------------------ */

func (s *Server) accountRequestPasswordReset(ctx context.Context, email string) error {
	user, err := s.userByEmail(ctx, email)
	if err == sql.ErrNoRows {
		return nil // Don't reveal whether the email exists
	}
	if err != nil {
		return err
	}
	if user.Provider == "google" && user.Password == nil {
		return nil
	}
	otp, err := accountGenerateOtp()
	if err != nil {
		return err
	}
	otpHash, err := hashPassword(otp)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET resetOtpHash = ?, resetOtpExpiresAt = ?, resetOtpAttempts = 0, updatedAt = ? WHERE id = ?",
		otpHash, now.Add(accountOtpTTL), now, user.ID); err != nil {
		return err
	}
	// Mail failures are swallowed here, exactly as MailerService.send is in
	// account.service.ts: a mail outage must not turn the anti-enumeration
	// response into a 400 that tells the caller whether the address exists or
	// whether SMTP is configured.
	if err := s.accountSendOtp(ctx, user.Email, "reset", otp); err != nil {
		s.Log.Warn("reset code mail failed", "err", err)
	}
	return nil
}

func (s *Server) handleAccountForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	email := strings.TrimSpace(body.Email)
	if msg := emailError(email); msg != "" {
		s.validationFail(w, "body.email", msg)
		return
	}
	if s.accountRateLimited(r, email, "") {
		s.Fail(w, http.StatusTooManyRequests, accountRateMessage)
		return
	}
	if err := s.accountRequestPasswordReset(r.Context(), email); err != nil {
		s.Log.Warn("forgot-password failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to send reset code.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success", "message": "If the email exists, a reset code has been sent.",
	})
}

func (s *Server) accountResetPassword(ctx context.Context, email, otp, newPassword string) error {
	user, err := s.userByEmail(ctx, email)
	if err == sql.ErrNoRows {
		return BadRequest("Invalid or expired reset code")
	}
	if err != nil {
		return err
	}
	if user.ResetOtpHash == nil || user.ResetOtpExpiresAt == nil {
		return BadRequest("Invalid or expired reset code")
	}
	now := time.Now().UTC()
	if user.ResetOtpExpiresAt.Before(now) {
		return BadRequest("Reset code expired. Please request a new one.")
	}
	if user.ResetOtpAttempts >= accountMaxOtpAttempts {
		// Burn the code so the attempts already spent cannot be extended.
		_, _ = s.DB.ExecContext(ctx,
			"UPDATE `User` SET resetOtpHash = NULL, resetOtpExpiresAt = NULL, updatedAt = ? WHERE id = ?", now, user.ID)
		return BadRequest("Too many attempts. Please request a new code.")
	}
	if !verifyPassword(otp, *user.ResetOtpHash) {
		_, _ = s.DB.ExecContext(ctx,
			"UPDATE `User` SET resetOtpAttempts = resetOtpAttempts + 1, updatedAt = ? WHERE id = ?", now, user.ID)
		return BadRequest("Invalid reset code")
	}
	hashed, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET password = ?, resetOtpHash = NULL, resetOtpExpiresAt = NULL, resetOtpAttempts = 0, "+
			"failedAttempts = 0, lockedUntil = NULL, updatedAt = ? WHERE id = ?",
		hashed, now, user.ID); err != nil {
		return err
	}
	s.revokeAllSessions(ctx, user.ID, "password_reset")
	s.audit(ctx, "user.password_reset", &user.ID, nil, nil, nil)
	return nil
}

func (s *Server) handleAccountResetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email       string `json:"email"`
		Otp         string `json:"otp"`
		NewPassword string `json:"newPassword"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	email := strings.TrimSpace(body.Email)
	if msg := emailError(email); msg != "" {
		s.validationFail(w, "body.email", msg)
		return
	}
	otp := strings.TrimSpace(body.Otp)
	if !digits6(otp) {
		s.validationFail(w, "body.otp", "OTP must be 6 digits")
		return
	}
	if msg := passwordError(body.NewPassword); msg != "" {
		s.validationFail(w, "body.newPassword", msg)
		return
	}
	if s.accountRateLimited(r, email, "") {
		s.Fail(w, http.StatusTooManyRequests, accountRateMessage)
		return
	}
	if err := s.accountResetPassword(r.Context(), email, otp, body.NewPassword); err != nil {
		s.accountFail(w, err, http.StatusBadRequest, "Failed to reset password.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

/* ------------------------------------------------------------------ *
 * POST /account/verify-email, /account/resend-verification
 * ------------------------------------------------------------------ */

func (s *Server) accountRequestEmailVerification(ctx context.Context, email string) error {
	user, err := s.userByEmail(ctx, email)
	if err == sql.ErrNoRows {
		return nil // don't leak state
	}
	if err != nil {
		return err
	}
	if user.IsVerified {
		return nil
	}
	otp, err := accountGenerateOtp()
	if err != nil {
		return err
	}
	otpHash, err := hashPassword(otp)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	// A dedicated slot: requesting a verification code must not invalidate an
	// in-flight password reset.
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET verifyOtpHash = ?, verifyOtpExpiresAt = ?, verifyOtpAttempts = 0, updatedAt = ? WHERE id = ?",
		otpHash, now.Add(accountOtpTTL), now, user.ID); err != nil {
		return err
	}
	// Same swallow as the reset flow, for the same reason.
	if err := s.accountSendOtp(ctx, user.Email, "verify", otp); err != nil {
		s.Log.Warn("verification code mail failed", "err", err)
	}
	return nil
}

func (s *Server) handleAccountResendVerification(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	email := strings.TrimSpace(body.Email)
	if msg := emailError(email); msg != "" {
		s.validationFail(w, "body.email", msg)
		return
	}
	if s.accountRateLimited(r, email, "") {
		s.Fail(w, http.StatusTooManyRequests, accountRateMessage)
		return
	}
	if err := s.accountRequestEmailVerification(r.Context(), email); err != nil {
		s.Log.Warn("resend-verification failed", "err", err)
		s.Fail(w, http.StatusBadRequest, "Failed to send verification code.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success", "message": "If the email exists, a verification code has been sent.",
	})
}

func (s *Server) accountVerifyEmail(ctx context.Context, email, otp string) error {
	user, err := s.userByEmail(ctx, email)
	if err == sql.ErrNoRows {
		return Conflict("Invalid or already verified")
	}
	if err != nil {
		return err
	}
	if user.IsVerified {
		return Conflict("Invalid or already verified")
	}
	if user.VerifyOtpHash == nil || user.VerifyOtpExpiresAt == nil {
		return BadRequest("Verification code expired. Please request a new one.")
	}
	now := time.Now().UTC()
	if user.VerifyOtpExpiresAt.Before(now) {
		return BadRequest("Verification code expired. Please request a new one.")
	}
	if user.VerifyOtpAttempts >= accountMaxOtpAttempts {
		_, _ = s.DB.ExecContext(ctx,
			"UPDATE `User` SET verifyOtpHash = NULL, verifyOtpExpiresAt = NULL, updatedAt = ? WHERE id = ?", now, user.ID)
		return BadRequest("Too many attempts. Please request a new code.")
	}
	if !verifyPassword(otp, *user.VerifyOtpHash) {
		_, _ = s.DB.ExecContext(ctx,
			"UPDATE `User` SET verifyOtpAttempts = verifyOtpAttempts + 1, updatedAt = ? WHERE id = ?", now, user.ID)
		return BadRequest("Invalid verification code")
	}
	_, err = s.DB.ExecContext(ctx,
		"UPDATE `User` SET isVerified = true, verifyOtpHash = NULL, verifyOtpExpiresAt = NULL, verifyOtpAttempts = 0, "+
			"updatedAt = ? WHERE id = ?", now, user.ID)
	if err != nil {
		return err
	}
	return nil
}

func (s *Server) handleAccountVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
		Otp   string `json:"otp"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	email := strings.TrimSpace(body.Email)
	if msg := emailError(email); msg != "" {
		s.validationFail(w, "body.email", msg)
		return
	}
	otp := strings.TrimSpace(body.Otp)
	if !digits6(otp) {
		s.validationFail(w, "body.otp", "OTP must be 6 digits")
		return
	}
	if err := s.accountVerifyEmail(r.Context(), email, otp); err != nil {
		s.accountFail(w, err, http.StatusBadRequest, "Verification failed.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

/* ------------------------------------------------------------------ *
 * Two-factor (twoFactor.service.ts)
 * ------------------------------------------------------------------ */

var accountTwoFactorCodeRe = regexp.MustCompile(`(?i)^(\d{6}|[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})$`)

func accountTwoFactorCodeOK(code string) bool { return accountTwoFactorCodeRe.MatchString(code) }

// accountVerifyTotp is speakeasy's `totp.verify({encoding:"base32", window:1})`:
// six digits, SHA-1, 30-second period, +/- one step of tolerance.
func (s *Server) accountVerifyTotp(secret, code string) bool {
	return totp.Validate(strings.TrimSpace(code), secret)
}

func accountCurrentTotpStep() int64 {
	return time.Now().UTC().Unix() / 30
}

// accountConsumeTotpStep accepts a live code once: the conditional update only
// matches while no equal-or-higher step has been recorded, so a captured code
// cannot mint a second session inside its tolerance window.
func (s *Server) accountConsumeTotpStep(ctx context.Context, userID, secret, code string) (bool, error) {
	if !s.accountVerifyTotp(secret, code) {
		return false, nil
	}
	step := accountCurrentTotpStep()
	res, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET lastTotpStep = ?, updatedAt = ? WHERE id = ? AND (lastTotpStep IS NULL OR lastTotpStep < ?)",
		step, time.Now().UTC(), userID, step)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// accountConsumeBackupCode returns true and consumes the code when it matches
// an unused backup, as a compare-and-swap on the whole JSON column.
func (s *Server) accountConsumeBackupCode(ctx context.Context, userID, code string) (bool, error) {
	candidate := strings.ToUpper(strings.TrimSpace(code))
	// Bounded, because each attempt costs an argon2 verify.
	for attempt := 0; attempt < 3; attempt++ {
		var stored sql.NullString
		err := s.DB.QueryRowContext(ctx, "SELECT backupCodes FROM `User` WHERE id = ?", userID).Scan(&stored)
		if err != nil || !stored.Valid || stored.String == "" {
			return false, nil
		}
		var hashes []string
		if err := json.Unmarshal([]byte(stored.String), &hashes); err != nil {
			return false, nil
		}
		matchIndex := -1
		for i, hash := range hashes {
			if verifyPassword(candidate, hash) {
				matchIndex = i
				break
			}
		}
		if matchIndex < 0 {
			return false, nil
		}
		remaining := append(append([]string{}, hashes[:matchIndex]...), hashes[matchIndex+1:]...)
		var next any
		if len(remaining) > 0 {
			raw, err := json.Marshal(remaining)
			if err != nil {
				return false, nil
			}
			next = string(raw)
		}
		res, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET backupCodes = ?, updatedAt = ? WHERE id = ? AND backupCodes = ?",
			next, time.Now().UTC(), userID, stored.String)
		if err != nil {
			return false, err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			return true, nil
		}
		// Lost the race; re-read and decide again.
	}
	return false, nil
}

// accountGenerateBackupCodes mints ten single-use recovery codes (4-4-4 hex
// groups), stores them argon2-hashed and returns the plaintext once.
func (s *Server) accountGenerateBackupCodes(ctx context.Context, userID string) ([]string, error) {
	codes := make([]string, 10)
	hashes := make([]string, 10)
	for i := range codes {
		raw := make([]byte, 6)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		hexed := strings.ToUpper(hex.EncodeToString(raw))
		codes[i] = hexed[0:4] + "-" + hexed[4:8] + "-" + hexed[8:12]
		hashed, err := hashPassword(codes[i])
		if err != nil {
			return nil, err
		}
		hashes[i] = hashed
	}
	encoded, err := json.Marshal(hashes)
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET backupCodes = ?, updatedAt = ? WHERE id = ?",
		string(encoded), time.Now().UTC(), userID); err != nil {
		return nil, err
	}
	return codes, nil
}

// accountPendingTokenMessage maps this port's JWT failures onto the messages
// jsonwebtoken raises, which the controller's publicMessageFor discloses.
func accountPendingTokenMessage(err error) string {
	message := err.Error()
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "expired"):
		return "jwt expired"
	case strings.Contains(lower, "malformed"):
		return "jwt malformed"
	case strings.Contains(lower, "signature"):
		return "invalid signature"
	case strings.Contains(lower, "audience"):
		return "jwt audience invalid. expected: mindease:2fa-pending"
	case strings.Contains(message, `expected a "2fa-pending" token`):
		return `Expected a "2fa-pending" token`
	default:
		return "invalid token"
	}
}

// handleAccountTwoFactorVerify is POST /account/2fa/verify: it completes a
// login that was gated on a second factor and is the only place a pending
// token is accepted.
func (s *Server) handleAccountTwoFactorVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
		Code  string `json:"code"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if body.Token == "" || len(body.Token) > 4096 {
		s.validationFail(w, "body.token", "Token is required")
		return
	}
	code := strings.TrimSpace(body.Code)
	if !accountTwoFactorCodeOK(code) {
		s.validationFail(w, "body.code", "Invalid verification code")
		return
	}
	if s.accountRateLimited(r, "", body.Token) {
		s.Fail(w, http.StatusTooManyRequests, accountRateMessage)
		return
	}

	// The controller maps every failure on this route to 401.
	claims, err := s.verifyToken(body.Token, purposeTwoFactor)
	if err != nil {
		s.Fail(w, http.StatusUnauthorized, accountPendingTokenMessage(err))
		return
	}
	userID, _ := claims["userId"].(string)
	if userID == "" {
		s.Fail(w, http.StatusUnauthorized, "Invalid token")
		return
	}
	ctx := r.Context()
	user, err := s.userByID(ctx, userID)
	if err != nil && err != sql.ErrNoRows {
		s.Fail(w, http.StatusUnauthorized, "Something went wrong. Please try again.")
		return
	}
	if user == nil || user.TotpSecret == nil || !user.TotpEnabled {
		s.Fail(w, http.StatusUnauthorized, "Invalid or expired verification session")
		return
	}
	if user.IsBanned {
		s.Fail(w, http.StatusUnauthorized, "Account suspended. Contact support.")
		return
	}

	// Either a live, not-yet-used TOTP code or an unused backup code.
	accepted, err := s.accountConsumeTotpStep(ctx, user.ID, *user.TotpSecret, code)
	if err != nil {
		s.Fail(w, http.StatusUnauthorized, "Something went wrong. Please try again.")
		return
	}
	if !accepted {
		used, err := s.accountConsumeBackupCode(ctx, user.ID, code)
		if err != nil {
			s.Fail(w, http.StatusUnauthorized, "Something went wrong. Please try again.")
			return
		}
		if !used {
			s.Fail(w, http.StatusUnauthorized, "Invalid verification code")
			return
		}
	}

	// `amr: ["pwd","otp"]` records that this session cleared a second factor.
	tokens, err := s.generateTokens(user, []string{"pwd", "otp"})
	if err != nil {
		s.Fail(w, http.StatusUnauthorized, "Something went wrong. Please try again.")
		return
	}
	if err := s.storeRefreshToken(ctx, user.ID, tokens.RefreshToken); err != nil {
		s.Fail(w, http.StatusUnauthorized, "Something went wrong. Please try again.")
		return
	}
	setSessionCookies(w, s.Cfg.IsProd, tokens.AccessToken, tokens.RefreshToken)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"user": user.Safe()}})
}

// handleAccountTwoFactorSetup is POST /account/2fa/setup. Enrolment is a
// privilege change: a password-confirmed account must confirm its password,
// and the decision is keyed on `provider`, failing closed.
func (s *Server) handleAccountTwoFactorSetup(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	var body struct {
		Password *string `json:"password"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if body.Password != nil {
		if *body.Password == "" || len(*body.Password) > 200 {
			s.validationFail(w, "body.password", "Password confirmation is required")
			return
		}
	}
	ctx := r.Context()
	existing, err := s.userByID(ctx, user.ID)
	if err != nil && err != sql.ErrNoRows {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	passwordless := existing != nil && existing.Provider == "google"
	if !passwordless {
		confirmed := existing != nil && existing.Password != nil && body.Password != nil &&
			verifyPassword(*body.Password, *existing.Password)
		if !confirmed {
			s.Fail(w, http.StatusBadRequest, "Password confirmation required to set up two-factor authentication")
			return
		}
	}

	key, err := totp.Generate(totp.GenerateOpts{Issuer: accountAppName, AccountName: user.Email})
	if err != nil {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	secret := key.Secret()
	// A new secret invalidates any code accepted for the previous one.
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET totpSecret = ?, lastTotpStep = NULL, updatedAt = ? WHERE id = ?",
		secret, time.Now().UTC(), user.ID); err != nil {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	png, err := qrcode.Encode(key.URL(), qrcode.Medium, 256)
	if err != nil {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"secret":     secret,
		"otpauthUrl": key.URL(),
		"qrDataUrl":  "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	}})
}

// handleAccountTwoFactorEnable is POST /account/2fa/enable.
func (s *Server) handleAccountTwoFactorEnable(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	var body struct {
		Code string `json:"code"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	code := strings.TrimSpace(body.Code)
	if !digits6(code) {
		s.validationFail(w, "body.code", "Code must be 6 digits")
		return
	}
	ctx := r.Context()
	existing, err := s.userByID(ctx, user.ID)
	if err != nil && err != sql.ErrNoRows {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	if existing == nil || existing.TotpSecret == nil {
		s.Fail(w, http.StatusBadRequest, "Generate a secret first")
		return
	}
	if !s.accountVerifyTotp(*existing.TotpSecret, code) {
		s.Fail(w, http.StatusBadRequest, "Invalid code")
		return
	}
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET totpEnabled = true, updatedAt = ? WHERE id = ?",
		time.Now().UTC(), user.ID); err != nil {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	// Enabling a second factor must not leave older sessions usable.
	s.revokeAllSessions(ctx, user.ID, "2fa_enabled")
	backupCodes, err := s.accountGenerateBackupCodes(ctx, user.ID)
	if err != nil {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data":   map[string]any{"success": true, "backupCodes": backupCodes},
	})
}

// handleAccountTwoFactorDisable is POST /account/2fa/disable.
func (s *Server) handleAccountTwoFactorDisable(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	var body struct {
		Code     string `json:"code"`
		Password string `json:"password"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	code := strings.TrimSpace(body.Code)
	if !digits6(code) {
		s.validationFail(w, "body.code", "Code must be 6 digits")
		return
	}
	if body.Password == "" || len(body.Password) > 200 {
		s.validationFail(w, "body.password", "Password confirmation is required")
		return
	}
	ctx := r.Context()
	existing, err := s.userByID(ctx, user.ID)
	if err != nil && err != sql.ErrNoRows {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	if existing == nil || existing.TotpSecret == nil || !existing.TotpEnabled {
		s.Fail(w, http.StatusBadRequest, "2FA is not enabled")
		return
	}
	if !s.accountVerifyTotp(*existing.TotpSecret, code) {
		s.Fail(w, http.StatusBadRequest, "Invalid code")
		return
	}
	// Disabling 2FA is sensitive: require both the TOTP code and a fresh
	// password confirmation.
	if existing.Password == nil || !verifyPassword(body.Password, *existing.Password) {
		s.Fail(w, http.StatusBadRequest, "Password confirmation required to disable two-factor authentication")
		return
	}
	if _, err := s.DB.ExecContext(ctx,
		"UPDATE `User` SET totpEnabled = false, totpSecret = NULL, backupCodes = NULL, lastTotpStep = NULL, updatedAt = ? WHERE id = ?",
		time.Now().UTC(), user.ID); err != nil {
		s.Fail(w, http.StatusBadRequest, "Something went wrong. Please try again.")
		return
	}
	s.revokeAllSessions(ctx, user.ID, "2fa_disabled")
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{"success": true}})
}

/* ------------------------------------------------------------------ *
 * DELETE /account/me
 * ------------------------------------------------------------------ */

func (s *Server) handleAccountDelete(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	var body struct {
		Password string  `json:"password"`
		Code     *string `json:"code"`
	}
	if err := accountDecodeBody(r, &body); err != nil {
		s.validationFail(w, "body", "Validation Error")
		return
	}
	if body.Password == "" || len(body.Password) > 200 {
		s.validationFail(w, "body.password", "Password confirmation is required")
		return
	}
	var code *string
	if body.Code != nil {
		trimmed := strings.TrimSpace(*body.Code)
		if !digits6(trimmed) {
			s.validationFail(w, "body.code", "Code must be 6 digits")
			return
		}
		code = &trimmed
	}
	ctx := r.Context()

	// Re-authenticate before the single most destructive request in the API.
	existing, err := s.userByID(ctx, user.ID)
	if err != nil && err != sql.ErrNoRows {
		s.accountFail(w, err, http.StatusBadRequest, "Failed to delete account.")
		return
	}
	if existing == nil {
		s.Fail(w, http.StatusNotFound, "Account not found")
		return
	}
	if existing.Password == nil {
		s.Fail(w, http.StatusBadRequest, "This account signs in with Google and has no password. Contact support to delete it.")
		return
	}
	if !verifyPassword(body.Password, *existing.Password) {
		s.Fail(w, http.StatusUnauthorized, "Password is incorrect")
		return
	}
	if existing.TotpEnabled && existing.TotpSecret != nil {
		if code == nil || !s.accountVerifyTotp(*existing.TotpSecret, *code) {
			s.Fail(w, http.StatusBadRequest, "A valid two-factor code is required")
			return
		}
	}

	if err := s.accountDeleteUser(ctx, user.ID); err != nil {
		s.accountFail(w, err, http.StatusBadRequest, "Failed to delete account.")
		return
	}
	clearSessionCookies(w, s.Cfg.IsProd)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "message": "Account deleted."})
}

// accountDeleteUser is the GDPR-style purge: PII is destroyed, anonymised
// records survive in the order account.service.ts deletes them.
func (s *Server) accountDeleteUser(ctx context.Context, userID string) error {
	var doctorID sql.NullString
	err := s.DB.QueryRowContext(ctx,
		"SELECT d.id FROM `User` u LEFT JOIN `Doctor` d ON d.userId = u.id WHERE u.id = ?", userID).Scan(&doctorID)
	if err == sql.ErrNoRows {
		return NotFound("User not found")
	}
	if err != nil {
		return err
	}
	// `""` rather than `-1`: ids are UUID strings, and an empty string is the
	// value no row has.
	docID := ""
	if doctorID.Valid {
		docID = doctorID.String
	}

	// Doctors whose public rating is influenced by this user's reviews.
	rows, err := s.DB.QueryContext(ctx, "SELECT DISTINCT doctorId FROM `Review` WHERE userId = ?", userID)
	if err != nil {
		return err
	}
	var ratedDoctors []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ratedDoctors = append(ratedDoctors, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Derived from a random source rather than the row id, so the export never
	// echoes the internal primary key.
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	anonymizedEmail := "deleted-" + hex.EncodeToString(suffix) + "@deleted.invalid"
	now := time.Now().UTC()

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	statements := []struct {
		query string
		args  []any
	}{
		{"DELETE FROM `JournalEntry` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `Assessment` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `PushSubscription` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `WaitlistEntry` WHERE patientId = ?", []any{userID}},
		{"DELETE FROM `Referral` WHERE referrerId = ? OR referredId = ?", []any{userID, userID}},
		{"DELETE FROM `PackagePurchase` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `Review` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `MoodEntry` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `Message` WHERE senderId = ? OR receiverId = ?", []any{userID, userID}},
		{"DELETE FROM `Notification` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `RefreshToken` WHERE userId = ?", []any{userID}},
		// Clinical disclosures: the free-text pre-session answers and the AI
		// briefing derived from them must not survive deletion.
		{"DELETE ps FROM `PreSessionData` ps INNER JOIN `Appointment` a ON a.id = ps.appointmentId WHERE a.userId = ?", []any{userID}},
		{"DELETE f FROM `FollowUp` f INNER JOIN `Appointment` a ON a.id = f.appointmentId WHERE a.userId = ?", []any{userID}},
		{"DELETE FROM `SafetyPlan` WHERE userId = ?", []any{userID}},
		// Cascades to CareGoal and CareStep in the schema.
		{"DELETE FROM `CarePlan` WHERE userId = ?", []any{userID}},
		{"DELETE FROM `AvailabilityPattern` WHERE doctorId = ?", []any{docID}},
		{"DELETE FROM `ConsultationSlot` WHERE doctorId = ?", []any{docID}},
		{"UPDATE `Appointment` SET notes = NULL, status = 'cancelled', updatedAt = ? WHERE userId = ? OR doctorId = ?",
			[]any{now, userID, docID}},
		// The doctor profile is ANONYMISED, never deleted: relations cascade
		// from it, and deleting it would erase patients' treatment records.
		{"UPDATE `Doctor` SET bio = '', education = NULL, languages = NULL, bankName = NULL, bankAccount = NULL, " +
			"bankHolder = NULL, licenseNumber = NULL, licenseIssuer = NULL, availability = 'Unavailable', " +
			"verificationStatus = 'removed', awayUntil = NULL, rating = 0, totalReviews = 0, updatedAt = ? WHERE userId = ?",
			[]any{now, userID}},
		{"UPDATE `User` SET email = ?, name = 'Deleted User', password = NULL, phone_number = NULL, avatar = NULL, " +
			"googleId = NULL, provider = 'deleted', isBanned = true, resetOtpHash = NULL, resetOtpExpiresAt = NULL, " +
			"resetOtpAttempts = 0, verifyOtpHash = NULL, verifyOtpExpiresAt = NULL, verifyOtpAttempts = 0, " +
			"totpSecret = NULL, totpEnabled = false, backupCodes = NULL, lastTotpStep = NULL, weeklyReportEnabled = false, " +
			"notificationPrefs = NULL, lastMoodNudgeAt = NULL, lastDeclineNudgeAt = NULL, sessionCredits = 0, " +
			"referralCode = NULL, timezone = NULL, updatedAt = ? WHERE id = ?",
			[]any{anonymizedEmail, now, userID}},
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	// Deleted reviews must stop influencing doctors' public averages.
	for _, doctorID := range ratedDoctors {
		if err := s.reviewRecalcDoctorRating(ctx, doctorID); err != nil {
			s.Log.Warn("rating recalculation after account deletion failed", "doctorId", doctorID, "err", err)
		}
	}

	targetType := "User"
	s.audit(ctx, "user.account_deleted", &userID, &targetType, &userID, nil)
	return nil
}

/* ------------------------------------------------------------------ *
 * GET /account/export
 * ------------------------------------------------------------------ */

func (s *Server) handleAccountExport(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	exportData, err := s.accountExportData(r.Context(), user.ID)
	if err != nil {
		s.accountFail(w, err, http.StatusInternalServerError, "Failed to export data.")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="mindease-data-`+user.ID+`.json"`)
	s.JSON(w, http.StatusOK, exportData)
}

// accountExportData mirrors the controller's Promise.all of selects, keyed by
// the export object's field names.
func (s *Server) accountExportData(ctx context.Context, userID string) (map[string]any, error) {
	user, err := s.accountExportUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	appointments, err := s.accountExportAppointments(ctx, userID)
	if err != nil {
		return nil, err
	}
	moods, err := s.accountExportMoods(ctx, userID)
	if err != nil {
		return nil, err
	}
	preSession, err := s.accountExportPreSession(ctx, userID)
	if err != nil {
		return nil, err
	}
	reviews, err := s.accountExportReviews(ctx, userID)
	if err != nil {
		return nil, err
	}
	messages, err := s.accountExportMessages(ctx, userID)
	if err != nil {
		return nil, err
	}
	journal, err := s.accountExportJournal(ctx, userID)
	if err != nil {
		return nil, err
	}
	assessments, err := s.accountExportAssessments(ctx, userID)
	if err != nil {
		return nil, err
	}
	safetyPlan, err := s.accountExportSafetyPlan(ctx, userID)
	if err != nil {
		return nil, err
	}
	carePlan, err := s.accountExportCarePlans(ctx, userID)
	if err != nil {
		return nil, err
	}
	riskAlerts, err := s.accountExportRiskAlerts(ctx, userID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"generatedAt":  nowISO(),
		"user":         user,
		"appointments": appointments,
		"moods":        moods,
		"preSession":   preSession,
		"reviews":      reviews,
		"messagesSent": messages,
		"journal":      journal,
		"assessments":  assessments,
		"safetyPlan":   safetyPlan,
		"carePlan":     carePlan,
		"riskAlerts":   riskAlerts,
	}, nil
}

func (s *Server) accountExportUser(ctx context.Context, userID string) (map[string]any, error) {
	var (
		email, role, provider     string
		name, avatar, phoneNumber sql.NullString
		createdAt                 time.Time
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT email, name, avatar, role, phone_number, provider, createdAt FROM `User` WHERE id = ?", userID).
		Scan(&email, &name, &avatar, &role, &phoneNumber, &provider, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"email":        email,
		"name":         strPtr(name),
		"avatar":       strPtr(avatar),
		"role":         role,
		"phone_number": strPtr(phoneNumber),
		"provider":     provider,
		"createdAt":    jsTimeValue(createdAt),
	}, nil
}

func (s *Server) accountExportAppointments(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT appointmentDate, startTime, endTime, consultationType, status, notes, meetingLink, createdAt "+
			"FROM `Appointment` WHERE userId = ? ORDER BY createdAt DESC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			appointmentDate           time.Time
			startTime, endTime, notes sql.NullString
			meetingLink               sql.NullString
			consultationType, status  string
			createdAt                 time.Time
		)
		if err := rows.Scan(&appointmentDate, &startTime, &endTime, &consultationType, &status, &notes, &meetingLink, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"appointmentDate":  jsTimeValue(appointmentDate),
			"startTime":        strPtr(startTime),
			"endTime":          strPtr(endTime),
			"consultationType": consultationType,
			"status":           status,
			"notes":            strPtr(notes),
			"meetingLink":      strPtr(meetingLink),
			"createdAt":        jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportMoods(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT mood, notes, factors, moodDate, createdAt FROM `MoodEntry` WHERE userId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			mood           int
			notes, factors sql.NullString
			moodDate       string
			createdAt      time.Time
		)
		if err := rows.Scan(&mood, &notes, &factors, &moodDate, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"mood":      mood,
			"notes":     strPtr(notes),
			"factors":   strPtr(factors),
			"moodDate":  moodDate,
			"createdAt": jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportPreSession(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT ps.questionsJson, ps.answersJson, ps.briefingText, ps.briefingSource, ps.updatedAt "+
			"FROM `PreSessionData` ps INNER JOIN `Appointment` a ON a.id = ps.appointmentId WHERE a.userId = ?", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			questions, answers, briefing sql.NullString
			briefingSource               string
			updatedAt                    time.Time
		)
		if err := rows.Scan(&questions, &answers, &briefing, &briefingSource, &updatedAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"questionsJson":  strPtr(questions),
			"answersJson":    strPtr(answers),
			"briefingText":   strPtr(briefing),
			"briefingSource": briefingSource,
			"updatedAt":      jsTimeValue(updatedAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportReviews(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT rating, comment, doctorId, createdAt FROM `Review` WHERE userId = ?", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			rating    int
			comment   string
			doctorID  string
			createdAt time.Time
		)
		if err := rows.Scan(&rating, &comment, &doctorID, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"rating":    rating,
			"comment":   comment,
			"doctorId":  doctorID,
			"createdAt": jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportMessages(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT content, receiverId, createdAt FROM `Message` WHERE senderId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			content    string
			receiverID string
			createdAt  time.Time
		)
		if err := rows.Scan(&content, &receiverID, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"content":    content,
			"receiverId": receiverID,
			"createdAt":  jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportJournal(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT content, aiSummary, createdAt FROM `JournalEntry` WHERE userId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			content   string
			aiSummary sql.NullString
			createdAt time.Time
		)
		if err := rows.Scan(&content, &aiSummary, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"content":   content,
			"aiSummary": strPtr(aiSummary),
			"createdAt": jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportAssessments(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT type, answersJson, score, severity, createdAt FROM `Assessment` WHERE userId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			assessmentType string
			answersJSON    string
			score          int
			severity       string
			createdAt      time.Time
		)
		if err := rows.Scan(&assessmentType, &answersJSON, &score, &severity, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"type":        assessmentType,
			"answersJson": answersJSON,
			"score":       score,
			"severity":    severity,
			"createdAt":   jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}

func (s *Server) accountExportSafetyPlan(ctx context.Context, userID string) (map[string]any, error) {
	var (
		warningSigns, copingStrategies, reasonsToLive   sql.NullString
		contacts, professionalContact, locationToBeSafe sql.NullString
		lastReviewedAt                                  sql.NullTime
		createdAt, updatedAt                            time.Time
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT warningSigns, copingStrategies, reasonsToLive, contacts, professionalContact, locationToBeSafe, "+
			"lastReviewedAt, createdAt, updatedAt FROM `SafetyPlan` WHERE userId = ?", userID).
		Scan(&warningSigns, &copingStrategies, &reasonsToLive, &contacts, &professionalContact, &locationToBeSafe,
			&lastReviewedAt, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"warningSigns":        strPtr(warningSigns),
		"copingStrategies":    strPtr(copingStrategies),
		"reasonsToLive":       strPtr(reasonsToLive),
		"contacts":            strPtr(contacts),
		"professionalContact": strPtr(professionalContact),
		"locationToBeSafe":    strPtr(locationToBeSafe),
		"lastReviewedAt":      jsTime(accountTimePtr(lastReviewedAt)),
		"createdAt":           jsTimeValue(createdAt),
		"updatedAt":           jsTimeValue(updatedAt),
	}, nil
}

func (s *Server) accountExportCarePlans(ctx context.Context, userID string) ([]map[string]any, error) {
	type accountCareGoal struct {
		ID         string
		Title      string
		Detail     sql.NullString
		Status     string
		TargetDate sql.NullTime
		Order      int
	}

	planRows, err := s.DB.QueryContext(ctx,
		"SELECT id, title, status, summary, reviewAt, createdAt FROM `CarePlan` WHERE userId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	type accountCarePlan struct {
		ID        string
		Title     string
		Status    string
		Summary   sql.NullString
		ReviewAt  sql.NullTime
		CreatedAt time.Time
	}
	plans := []accountCarePlan{}
	for planRows.Next() {
		var plan accountCarePlan
		if err := planRows.Scan(&plan.ID, &plan.Title, &plan.Status, &plan.Summary, &plan.ReviewAt, &plan.CreatedAt); err != nil {
			planRows.Close()
			return nil, err
		}
		plans = append(plans, plan)
	}
	planRows.Close()
	if err := planRows.Err(); err != nil {
		return nil, err
	}

	out := []map[string]any{}
	for _, plan := range plans {
		goalRows, err := s.DB.QueryContext(ctx,
			"SELECT id, title, detail, status, targetDate, `order` FROM `CareGoal` WHERE carePlanId = ? ORDER BY `order` ASC", plan.ID)
		if err != nil {
			return nil, err
		}
		goals := []accountCareGoal{}
		for goalRows.Next() {
			var goal accountCareGoal
			if err := goalRows.Scan(&goal.ID, &goal.Title, &goal.Detail, &goal.Status, &goal.TargetDate, &goal.Order); err != nil {
				goalRows.Close()
				return nil, err
			}
			goals = append(goals, goal)
		}
		goalRows.Close()
		if err := goalRows.Err(); err != nil {
			return nil, err
		}

		goalMaps := []map[string]any{}
		for _, goal := range goals {
			stepRows, err := s.DB.QueryContext(ctx,
				"SELECT title, done, doneAt, `order` FROM `CareStep` WHERE careGoalId = ? ORDER BY `order` ASC", goal.ID)
			if err != nil {
				return nil, err
			}
			steps := []map[string]any{}
			for stepRows.Next() {
				var (
					title     string
					done      bool
					doneAt    sql.NullTime
					stepOrder int
				)
				if err := stepRows.Scan(&title, &done, &doneAt, &stepOrder); err != nil {
					stepRows.Close()
					return nil, err
				}
				steps = append(steps, map[string]any{
					"title":  title,
					"done":   done,
					"doneAt": jsTime(accountTimePtr(doneAt)),
					"order":  stepOrder,
				})
			}
			stepRows.Close()
			if err := stepRows.Err(); err != nil {
				return nil, err
			}
			goalMaps = append(goalMaps, map[string]any{
				"title":      goal.Title,
				"detail":     strPtr(goal.Detail),
				"status":     goal.Status,
				"targetDate": jsTime(accountTimePtr(goal.TargetDate)),
				"order":      goal.Order,
				"steps":      steps,
			})
		}
		out = append(out, map[string]any{
			"title":     plan.Title,
			"status":    plan.Status,
			"summary":   strPtr(plan.Summary),
			"reviewAt":  jsTime(accountTimePtr(plan.ReviewAt)),
			"createdAt": jsTimeValue(plan.CreatedAt),
			"goals":     goalMaps,
		})
	}
	return out, nil
}

func (s *Server) accountExportRiskAlerts(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT level, reason, sourceType, acknowledgedAt, resolvedAt, resolutionNote, createdAt "+
			"FROM `RiskAlert` WHERE userId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			level, reason, sourceType  string
			acknowledgedAt, resolvedAt sql.NullTime
			resolutionNote             sql.NullString
			createdAt                  time.Time
		)
		if err := rows.Scan(&level, &reason, &sourceType, &acknowledgedAt, &resolvedAt, &resolutionNote, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"level":          level,
			"reason":         reason,
			"sourceType":     sourceType,
			"acknowledgedAt": jsTime(accountTimePtr(acknowledgedAt)),
			"resolvedAt":     jsTime(accountTimePtr(resolvedAt)),
			"resolutionNote": strPtr(resolutionNote),
			"createdAt":      jsTimeValue(createdAt),
		})
	}
	return out, rows.Err()
}
