package hub

import (
	"errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims mirrors the Node API's access token payload.
type Claims struct {
	UserID int64  `json:"userId"`
	Role   string `json:"role"`
	// Purpose is one of "access" or "ws-ticket". The realtime service accepts
	// nothing else, so a refresh token or a pending two-factor ticket can never
	// open a socket.
	Purpose string `json:"purpose"`
	// TotpVerified is true when the session completed a second factor, or the
	// account needs none. The Node API enforces this on every REST request; this
	// service has no database, so the claim is the only thing standing between a
	// pre-two-factor session and the realtime channel.
	TotpVerified *bool `json:"totpVerified"`
	jwt.RegisteredClaims
}

const (
	purposeAccess   = "access"
	purposeWsTicket = "ws-ticket"
)

var secret []byte

func init() {
	secret = []byte(os.Getenv("JWT_SECRET"))
	if len(secret) == 0 {
		if os.Getenv("NODE_ENV") == "production" {
			panic("JWT_SECRET is required in production: refusing to start with an insecure default")
		}
		// Dev-only fallback — mirrors server/src/config/env.ts. Never used in production.
		secret = []byte("dev_only_insecure_jwt_secret_change_me")
	}
}

// Authenticate verifies a realtime credential and returns the user ID.
func Authenticate(tokenString string) (*Claims, error) {
	if tokenString == "" {
		return nil, errors.New("missing token")
	}

	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}

	// Reject expired tokens defensively (parser already checks exp)
	if claims.ExpiresAt != nil && claims.ExpiresAt.Before(time.Now()) {
		return nil, errors.New("token expired")
	}

	switch claims.Purpose {
	case purposeWsTicket:
		// Minted by the API only after a full session re-check, so the second
		// factor was already enforced at that point.
	case purposeAccess:
		// An access token opens a socket only if the session completed a second
		// factor (or needed none). Without this check the realtime channel was a
		// way around the REST two-factor gate, and it carries SOS alerts, risk
		// alerts and private chat.
		if claims.TotpVerified == nil || !*claims.TotpVerified {
			return nil, errors.New("two-factor verification required")
		}
	default:
		return nil, errors.New("unsupported token purpose")
	}

	return claims, nil
}
