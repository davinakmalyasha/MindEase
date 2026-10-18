package server

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

type contextKey int

const (
	userContextKey contextKey = iota
	requestIDContextKey
)

// UserCtx is what the auth middleware loads and every handler reads.
type UserCtx struct {
	ID              string
	Role            string
	Email           string
	Name            *string
	DoctorProfileID *string
}

func CurrentUser(r *http.Request) *UserCtx {
	user, _ := r.Context().Value(userContextKey).(*UserCtx)
	return user
}

// RequireRole guards a route group. It must be mounted after authenticate.
func (s *Server) RequireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, r := range roles {
		allowed[r] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := CurrentUser(r)
			if user == nil {
				s.Fail(w, http.StatusUnauthorized, "Unauthorized")
				return
			}
			if !allowed[user.Role] {
				s.Fail(w, http.StatusForbidden, "Forbidden")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// authenticate ports middleware/auth.middleware.ts: cookie or bearer token,
// purpose-checked verification, then a database read on every request so a
// banned user or a 2FA upgrade revokes live sessions immediately.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := ""
		if c, err := r.Cookie("accessToken"); err == nil && c.Value != "" {
			token = c.Value
		} else if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			token = strings.TrimPrefix(header, "Bearer ")
		}
		if token == "" {
			s.Fail(w, http.StatusUnauthorized, "Unauthorized")
			return
		}

		claims, err := s.verifyToken(token, purposeAccess)
		if err != nil {
			s.Log.Warn("token verification failed", "err", err)
			s.Fail(w, http.StatusUnauthorized, "Invalid Token")
			return
		}
		userID, _ := claims["userId"].(string)
		if userID == "" {
			s.Fail(w, http.StatusUnauthorized, "Invalid Token")
			return
		}

		var (
			user     UserCtx
			name     sql.NullString
			doctorID sql.NullString
			isBanned bool
			totpOn   bool
		)
		err = s.DB.QueryRowContext(r.Context(),
			"SELECT u.id, u.role, u.email, u.name, u.isBanned, u.totpEnabled, d.id "+
				"FROM `User` u LEFT JOIN `Doctor` d ON d.userId = u.id WHERE u.id = ?", userID).
			Scan(&user.ID, &user.Role, &user.Email, &name, &isBanned, &totpOn, &doctorID)
		if err == sql.ErrNoRows {
			s.Fail(w, http.StatusUnauthorized, "User not found")
			return
		}
		if err != nil {
			s.Log.Error("auth middleware db read failed", "err", err)
			s.Fail(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		if isBanned {
			s.Fail(w, http.StatusForbidden, "Account suspended. Contact support.")
			return
		}
		if name.Valid {
			user.Name = &name.String
		}
		if doctorID.Valid {
			user.DoctorProfileID = &doctorID.String
		}

		totpVerified, _ := claims["totpVerified"].(bool)
		if totpOn && !totpVerified {
			s.Log.Warn("rejected access token without a completed second factor", "userId", user.ID)
			s.FailExtra(w, http.StatusUnauthorized, "Two-factor verification required", map[string]any{"code": "TOTP_REQUIRED"})
			return
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey, &user)))
	})
}

func setSessionCookies(w http.ResponseWriter, isProd bool, accessToken, refreshToken string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refreshToken",
		Value:    refreshToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   isProd,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(refreshTTL / time.Second),
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "accessToken",
		Value:    accessToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   isProd,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(accessTTL / time.Second),
	})
}

func clearSessionCookies(w http.ResponseWriter, isProd bool) {
	epoch := time.Unix(0, 0)
	for _, name := range []string{"refreshToken", "accessToken"} {
		http.SetCookie(w, &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			Secure:   isProd,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   -1,
			Expires:  epoch,
		})
	}
}
