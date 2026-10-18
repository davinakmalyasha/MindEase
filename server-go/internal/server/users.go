package server

import (
	"context"
	"database/sql"
	"time"
)

// userColumns is the full User row; Safe() strips what toSafeUser strips in
// auth.service.ts.
const userColumns = "id, email, password, name, avatar, role, phone_number, provider, googleId, " +
	"isBanned, isVerified, weeklyReportEnabled, notificationPrefs, referralCode, timezone, " +
	"lastMoodNudgeAt, lastDeclineNudgeAt, lastWeeklyReportAt, failedAttempts, lockedUntil, " +
	"totpSecret, totpEnabled, backupCodes, lastTotpStep, sessionCredits, resetOtpHash, " +
	"resetOtpExpiresAt, resetOtpAttempts, verifyOtpHash, verifyOtpExpiresAt, verifyOtpAttempts, " +
	"createdAt, updatedAt"

type UserRow struct {
	ID                  string
	Email               string
	Password            *string
	Name                *string
	Avatar              *string
	Role                string
	PhoneNumber         *string
	Provider            string
	GoogleID            *string
	IsBanned            bool
	IsVerified          bool
	WeeklyReportEnabled bool
	NotificationPrefs   *string
	ReferralCode        *string
	Timezone            *string
	LastMoodNudgeAt     *time.Time
	LastDeclineNudgeAt  *time.Time
	LastWeeklyReportAt  *time.Time
	FailedAttempts      int
	LockedUntil         *time.Time
	TotpSecret          *string
	TotpEnabled         bool
	BackupCodes         *string
	LastTotpStep        *int
	SessionCredits      int
	ResetOtpHash        *string
	ResetOtpExpiresAt   *time.Time
	ResetOtpAttempts    int
	VerifyOtpHash       *string
	VerifyOtpExpiresAt  *time.Time
	VerifyOtpAttempts   int
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

func scanUser(row *sql.Row) (*UserRow, error) {
	var u UserRow
	err := row.Scan(
		&u.ID, &u.Email, &u.Password, &u.Name, &u.Avatar, &u.Role, &u.PhoneNumber, &u.Provider,
		&u.GoogleID, &u.IsBanned, &u.IsVerified, &u.WeeklyReportEnabled, &u.NotificationPrefs,
		&u.ReferralCode, &u.Timezone, &u.LastMoodNudgeAt, &u.LastDeclineNudgeAt, &u.LastWeeklyReportAt,
		&u.FailedAttempts, &u.LockedUntil, &u.TotpSecret, &u.TotpEnabled, &u.BackupCodes,
		&u.LastTotpStep, &u.SessionCredits, &u.ResetOtpHash, &u.ResetOtpExpiresAt, &u.ResetOtpAttempts,
		&u.VerifyOtpHash, &u.VerifyOtpExpiresAt, &u.VerifyOtpAttempts, &u.CreatedAt, &u.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Server) userByID(ctx context.Context, id string) (*UserRow, error) {
	return scanUser(s.DB.QueryRowContext(ctx, "SELECT "+userColumns+" FROM `User` WHERE id = ?", id))
}

func (s *Server) userByEmail(ctx context.Context, email string) (*UserRow, error) {
	return scanUser(s.DB.QueryRowContext(ctx, "SELECT "+userColumns+" FROM `User` WHERE email = ?", email))
}

// Safe renders the user exactly as toSafeUser does: every field except the
// credential material and the failure counters.
func (u *UserRow) Safe() map[string]any {
	return map[string]any{
		"id":                  u.ID,
		"email":               u.Email,
		"name":                u.Name,
		"avatar":              u.Avatar,
		"role":                u.Role,
		"phone_number":        u.PhoneNumber,
		"provider":            u.Provider,
		"googleId":            u.GoogleID,
		"isBanned":            u.IsBanned,
		"isVerified":          u.IsVerified,
		"weeklyReportEnabled": u.WeeklyReportEnabled,
		"notificationPrefs":   u.NotificationPrefs,
		"referralCode":        u.ReferralCode,
		"timezone":            u.Timezone,
		"lastMoodNudgeAt":     jsTime(u.LastMoodNudgeAt),
		"lastDeclineNudgeAt":  jsTime(u.LastDeclineNudgeAt),
		"lastWeeklyReportAt":  jsTime(u.LastWeeklyReportAt),
		"totpEnabled":         u.TotpEnabled,
		"sessionCredits":      u.SessionCredits,
		"createdAt":           jsTimeValue(u.CreatedAt),
		"updatedAt":           jsTimeValue(u.UpdatedAt),
	}
}
