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

// TestAuthenticateRejectsForeignIssuer covers a token minted by any other
// component in the fleet that shares this secret.
//
// `iss` and `aud` were both parsed and then discarded: jwt/v5 populates
// RegisteredClaims from them, and nothing read the result. Node asserts both on
// every verification, so the two halves of the system disagreed about what a
// token had to contain, and this was the half that did not check.
func TestAuthenticateRejectsForeignIssuer(t *testing.T) {
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true
	claims["iss"] = "some-other-service"

	if _, err := Authenticate(mint(t, "iss", claims)); err == nil {
		t.Fatal("expected rejection for a token from another issuer")
	}
}

// TestAuthenticateRejectsWrongAudience is the load-bearing one.
//
// The websocket ticket is signed with the *access* secret, because this service
// only holds JWT_SECRET. The audience claim (`mindease:ws-ticket` vs
// `mindease:access`) is the entire mechanism that stops a 30-second ticket being
// replayed as a long-lived session - and this service was the one place the check
// was missing, so a captured ticket could open a socket indefinitely.
func TestAuthenticateRejectsWrongAudience(t *testing.T) {
	// An access token presented with the ticket's purpose: the audience and the
	// purpose disagree, which is the replay this must refuse.
	claims := baseClaims()
	claims["purpose"] = "ws-ticket"
	claims["aud"] = "mindease:access"
	claims["exp"] = time.Now().Add(30 * time.Second).Unix()
	delete(claims, "totpVerified")

	if _, err := Authenticate(mint(t, "aud", claims)); err == nil {
		t.Fatal("expected rejection when the audience does not match the purpose")
	}
}

func TestAuthenticateRejectsMissingAudience(t *testing.T) {
	// Both real token purposes carry an audience, so its absence means the token
	// was not minted by this system's signer.
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true
	delete(claims, "aud")

	if _, err := Authenticate(mint(t, "noaud", claims)); err == nil {
		t.Fatal("expected rejection for a token with no audience")
	}
}

func TestAuthenticateRejectsMissingExpiry(t *testing.T) {
	// `WithExpirationRequired` rather than "check exp if present". A token with no
	// expiry would otherwise be valid forever, which is the wrong default for a
	// credential that carries clinical alerts.
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true
	delete(claims, "exp")

	if _, err := Authenticate(mint(t, "noexp", claims)); err == nil {
		t.Fatal("expected rejection for a token with no expiry")
	}
}

func TestAuthenticateRejectsNonHS256(t *testing.T) {
	// The guard used to accept "any HMAC", which would have admitted HS384 and
	// HS512. Nothing in this system signs with those, and accepting them would be
	// a difference between the two halves of the system that nothing tests.
	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true

	other, err := jwt.NewWithClaims(jwt.SigningMethodHS512, claims).SignedString(secret)
	if err != nil {
		t.Fatalf("signing HS512 token: %v", err)
	}

	if _, err := Authenticate(other); err == nil {
		t.Fatal("expected rejection for an HS512 token")
	}
}
