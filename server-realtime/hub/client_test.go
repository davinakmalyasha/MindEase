package hub

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

// jwtSigned signs claims with an arbitrary secret, so a test can present a
// well-formed token that this service must still reject.
func jwtSigned(claims jwt.MapClaims, key string) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(key))
}

// TestServeWSRejectsBeforeUpgrading pins the ordering of authentication and
// the handshake.
//
// ServeWS used to call upgrader.Upgrade first and only then validate the
// token, so an unauthenticated caller completed a 101 handshake and held a live
// socket for the duration of the auth check. The client could not distinguish
// that from a normal disconnect either, so its reconnect loop retried a bad
// ticket indefinitely.
func TestServeWSRejectsBeforeUpgrading(t *testing.T) {
	tests := map[string]func(r *http.Request){
		"no credentials at all": func(r *http.Request) {},
		"garbage bearer token":  func(r *http.Request) { r.Header.Set("Authorization", "Bearer not-a-jwt") },
		"garbage query token":   func(r *http.Request) { r.URL.RawQuery = "token=not-a-jwt" },
		"empty bearer":          func(r *http.Request) { r.Header.Set("Authorization", "Bearer ") },
		"foreign signature": func(r *http.Request) {
			claims := baseClaims()
			claims["purpose"] = "access"
			claims["totpVerified"] = true
			tok, err := jwtSigned(claims, "some-other-secret")
			if err != nil {
				t.Fatalf("signing: %v", err)
			}
			r.URL.RawQuery = "token=" + tok
		},
	}

	h := New(DefaultLimits())

	for name, seed := range tests {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/ws", nil)
			// An allowed origin, so rejection can only come from auth or the cap.
			req.Header.Set("Origin", "http://localhost:3000")
			seed(req)

			rec := httptest.NewRecorder()
			h.ServeWS(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d (a rejected handshake must not be upgraded)",
					rec.Code, http.StatusUnauthorized)
			}
			if got := rec.Header().Get("Upgrade"); got != "" {
				t.Fatalf("Upgrade header = %q, want none", got)
			}
		})
	}
}

// TestServeWSEnforcesPerUserCapOverTheWire checks the cap is enforced on the
// real handshake path, not only in unit tests of the hub.
func TestServeWSEnforcesPerUserCapOverTheWire(t *testing.T) {
	h := New(Limits{MaxPerUser: 2, MaxTotal: 100})

	claims := baseClaims()
	claims["purpose"] = "access"
	claims["totpVerified"] = true
	token := mint(t, "access", claims)

	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	dial := func() (*websocket.Conn, *http.Response, error) {
		headers := http.Header{}
		headers.Set("Origin", "http://localhost:3000")
		url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws?token=" + token
		return websocket.DefaultDialer.Dial(url, headers)
	}

	var open []*websocket.Conn
	defer func() {
		for _, c := range open {
			_ = c.Close()
		}
	}()

	// The first two connections fit the cap.
	for i := 0; i < 2; i++ {
		c, _, err := dial()
		if err != nil {
			t.Fatalf("connection %d should have been accepted: %v", i, err)
		}
		open = append(open, c)
	}

	// The third is refused: the handshake succeeds, then the hub closes the
	// socket with a "try again later" code rather than leaving it hanging.
	c, _, err := dial()
	if err != nil {
		// Some paths reject during the handshake itself, which is also correct.
		return
	}
	defer func() { _ = c.Close() }()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = c.ReadMessage()
	if err == nil {
		t.Fatal("expected the over-cap connection to be closed")
	}
	if h.ConnectionCount() != 2 {
		t.Fatalf("connection count = %d, want 2", h.ConnectionCount())
	}
}
