package hub

import (
	"errors"
	"os"

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

// Mirrors ISSUER in server/src/lib/tokens.ts.
const issuer = "mindease"

// audienceFor mirrors the Node helper of the same name: `mindease:<purpose>`.
//
// Both claims were previously parsed and then ignored. Node asserts them on every
// verification, so the two halves of the system disagreed about what a token had
// to contain. The audience is the load-bearing one: it is the mechanism that stops
// a 30-second websocket ticket - signed with the *access* secret, because this
// service only holds JWT_SECRET - from being replayed as an access token, and
// this service was the one place that check was missing.
func audienceFor(purpose string) string {
	return "mindease:" + purpose
}

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

	expectedAudience := ""
	token, err := jwt.ParseWithClaims(
		tokenString,
		&Claims{},
		func(t *jwt.Token) (any, error) {
			// Pin the method to HMAC *and* to HS256 specifically. Checking only
			// "some HMAC" would accept HS384 and HS512 as well, which is not what
			// the Node signer uses and not what this intends to allow.
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("unexpected signing method")
			}
			if t.Method.Alg() != "HS256" {
				return nil, errors.New("unexpected signing algorithm")
			}
			return secret, nil
		},
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}

	switch claims.Purpose {
	case purposeWsTicket:
		// Minted by the API only after a full session re-check, so the second
		// factor was already enforced at that point.
		expectedAudience = audienceFor(purposeWsTicket)
	case purposeAccess:
		// An access token opens a socket only if the session completed a second
		// factor (or needed none). Without this check the realtime channel was a
		// way around the REST two-factor gate, and it carries SOS alerts, risk
		// alerts and private chat.
		if claims.TotpVerified == nil || !*claims.TotpVerified {
			return nil, errors.New("two-factor verification required")
		}
		expectedAudience = audienceFor(purposeAccess)
	default:
		return nil, errors.New("unsupported token purpose")
	}

	// Audience is checked after the purpose switch because the expected value is
	// derived from it. Comparing as a slice: the Node claim is a single string and
	// jwt/v5 represents it as a claim list.
	if !audienceMatches(claims.Audience, expectedAudience) {
		return nil, errors.New("unexpected token audience")
	}

	return claims, nil
}

// audienceMatches compares the claim against the single audience this service
// accepts. A token with no audience at all is rejected: both real token purposes
// carry one, so its absence means the token was not minted by this system's signer.
func audienceMatches(claim jwt.ClaimStrings, expected string) bool {
	if len(claim) != 1 {
		return false
	}
	return claim[0] == expected
}
