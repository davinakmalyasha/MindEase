package hub

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// mint builds a token the way server/src/lib/tokens.ts does, so these tests
// exercise the real signature, claim set and audience handling rather than a
// hand-rolled approximation.
func mint(t *testing.T, key string, claims jwt.MapClaims) string {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
	if err != nil {
		t.Fatalf("signing token: %v", err)
	}
	return token
}

func baseClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"userId": float64(42),
		"role":   "patient",
		"iss":    "mindease",
		"aud":    "mindease:access",
		"iat":    time.Now().Add(-time.Minute).Unix(),
		"exp":    time.Now().Add(15 * time.Minute).Unix(),
	}
}

// TestAuthenticateAcceptsAccessToken is the case that was previously never
// exercised: the old suite only fed Authenticate malformed input, so the
// signing path, the algorithm guard, expiry and the claim extraction were all
// untested.
func TestAuthenticateAcceptsAccessToken(t *testing.T) {
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true

	got, err := Authenticate(mint(t, "access", claims))
	if err != nil {
		t.Fatalf("Authenticate returned error for a valid access token: %v", err)
	}
	if got.UserID != 42 {
		t.Errorf("UserID = %d, want 42", got.UserID)
	}
	if got.Role != "patient" {
		t.Errorf("Role = %q, want \"patient\"", got.Role)
	}
}

func TestAuthenticateAcceptsWsTicket(t *testing.T) {
	claims := baseClaims()
	claims["purpose"] = "ws-ticket"
	claims["aud"] = "mindease:ws-ticket"
	claims["exp"] = time.Now().Add(30 * time.Second).Unix()
	// A ws ticket is minted after a full session re-check, so it carries no
	// totpVerified claim at all. It must still be accepted.
	delete(claims, "totpVerified")

	got, err := Authenticate(mint(t, "ticket", claims))
	if err != nil {
		t.Fatalf("Authenticate returned error for a valid ws ticket: %v", err)
	}
	if got.UserID != 42 {
		t.Errorf("UserID = %d, want 42", got.UserID)
	}
}

// TestAuthenticateRejectsUnsatisfiedSecondFactor covers the gap that let the
// realtime channel be a way around the REST two-factor gate: an access token
// from a session that never completed TOTP, carrying SOS alerts, risk alerts
// and private chat.
func TestAuthenticateRejectsUnsatisfiedSecondFactor(t *testing.T) {
	for name, verified := range map[string]any{
		"explicitly false": false,
		"claim absent":     nil,
	} {
		t.Run(name, func(t *testing.T) {
			claims := baseClaims()
			claims["purpose"] = "access"
			if verified != nil {
				claims["totpVerified"] = verified
			}

			if _, err := Authenticate(mint(t, "access", claims)); err == nil {
				t.Fatal("expected rejection for an access token without a completed second factor")
			}
		})
	}
}

func TestAuthenticateRejectsForeignPurpose(t *testing.T) {
	for _, purpose := range []string{"refresh", "2fa-pending", "", "whatever"} {
		t.Run("purpose="+purpose, func(t *testing.T) {
			claims := baseClaims()
			claims["purpose"] = purpose
			claims["totpVerified"] = true

			if _, err := Authenticate(mint(t, "x", claims)); err == nil {
				t.Fatalf("expected rejection for purpose %q", purpose)
			}
		})
	}
}

func TestAuthenticateRejectsExpired(t *testing.T) {
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true
	claims["exp"] = time.Now().Add(-time.Hour).Unix()

	if _, err := Authenticate(mint(t, "expired", claims)); err == nil {
		t.Fatal("expected rejection for an expired token")
	}
}

func TestAuthenticateRejectsForeignSignature(t *testing.T) {
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true

	other, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("a-different-secret"))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}

	if _, err := Authenticate(other); err == nil {
		t.Fatal("expected rejection for a token signed with a different secret")
	}
}

// TestAuthenticateRejectsAlgNone covers the classic algorithm-confusion attack:
// an unsigned token claiming HS256 must never be honoured.
func TestAuthenticateRejectsAlgNone(t *testing.T) {
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true

	unsigned, err := jwt.NewWithClaims(jwt.SigningMethodNone, claims).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("signing alg=none token: %v", err)
	}

	if _, err := Authenticate(unsigned); err == nil {
		t.Fatal("expected rejection for an alg=none token")
	}
}

func TestAuthenticateRejectsMalformed(t *testing.T) {
	for name, input := range map[string]string{
		"empty":       "",
		"not a jwt":   "not-a-jwt",
		"just dots":   "..",
		"random text": "abcdef",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Authenticate(input); err == nil {
				t.Fatalf("expected rejection for %q", input)
			}
		})
	}
}
