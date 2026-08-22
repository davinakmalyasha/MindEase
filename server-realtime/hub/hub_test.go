package hub

import (
	"net/http"
	"testing"
	"time"
)

func TestHubRegisterAndPublish(t *testing.T) {
	h := New()
	c := &Client{ID: 1, Send: make(chan Event, 4)}
	h.Register(1, c)

	if h.UserCount() != 1 {
		t.Fatalf("expected 1 connected user, got %d", h.UserCount())
	}

	h.PublishToUser(1, Event{Type: "message:new"})

	select {
	case ev := <-c.Send:
		if ev.Type != "message:new" {
			t.Fatalf("expected message:new, got %s", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("event was not delivered")
	}
}

func TestHubDoesNotCrossDeliver(t *testing.T) {
	h := New()
	a := &Client{ID: 1, Send: make(chan Event, 2)}
	b := &Client{ID: 2, Send: make(chan Event, 2)}
	h.Register(1, a)
	h.Register(2, b)

	h.PublishToUser(1, Event{Type: "only-for-one"})

	select {
	case <-b.Send:
		t.Fatal("user 2 received user 1's event")
	default:
	}

	select {
	case <-a.Send:
	default:
		t.Fatal("user 1 did not receive their event")
	}
}

func TestHubUnregister(t *testing.T) {
	h := New()
	c := &Client{ID: 1, Send: make(chan Event, 2)}
	h.Register(1, c)
	h.Unregister(1, c)

	if h.UserCount() != 0 {
		t.Fatalf("expected 0 connected users after unregister, got %d", h.UserCount())
	}
}

// TestHubDoubleUnregisterNoPanic reproduces the "close of closed channel"
// panic that occurred when both writePump and readPump unregister the same
// client (e.g. a user with multiple simultaneous connections).
func TestHubDoubleUnregisterNoPanic(t *testing.T) {
	h := New()
	for _, userID := range []int64{1, 2, 3} {
		c := &Client{ID: userID, Send: make(chan Event, 4)}
		h.Register(userID, c)
		h.Unregister(userID, c)
		h.Unregister(userID, c)
	}
	if h.UserCount() != 0 {
		t.Fatalf("expected 0 connected users, got %d", h.UserCount())
	}
}

// TestHubMultiConnectionUnregister registers two connections for one user
// (the real-world multi-tab scenario) and unregisters both, then verifies no
// events can be delivered and the hub stays consistent.
func TestHubMultiConnectionUnregister(t *testing.T) {
	h := New()
	a := &Client{ID: 7, Send: make(chan Event, 4)}
	b := &Client{ID: 7, Send: make(chan Event, 4)}
	h.Register(7, a)
	h.Register(7, b)

	if h.UserCount() != 1 {
		t.Fatalf("expected 1 connected user, got %d", h.UserCount())
	}

	h.Unregister(7, a)
	h.Unregister(7, b)

	if h.UserCount() != 0 {
		t.Fatalf("expected 0 connected users, got %d", h.UserCount())
	}

	// Publishing to an unregistered user must not panic.
	h.PublishToUser(7, Event{Type: "after-unregister"})
}

// TestHubConcurrentUnregister exercises the writePump/readPump race
// concurrently to flush out data races under -race.
func TestHubConcurrentUnregister(t *testing.T) {
	h := New()
	c := &Client{ID: 42, Send: make(chan Event, 4)}
	h.Register(42, c)

	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			h.Unregister(42, c)
			done <- struct{}{}
		}()
	}
	for i := 0; i < 2; i++ {
		<-done
	}
	if h.UserCount() != 0 {
		t.Fatalf("expected 0 connected users, got %d", h.UserCount())
	}
}

func TestAuthenticate(t *testing.T) {
	token := "not-a-jwt"
	if _, err := Authenticate(token); err == nil {
		t.Fatal("expected error for invalid token")
	}
	if _, err := Authenticate(""); err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestCheckOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		{"allows localhost dev origin", "http://localhost:3000", true},
		{"allows missing origin (non-browser clients)", "", true},
		{"rejects unknown cross-origin", "https://evil.example.com", false},
		{"rejects scheme-mismatched localhost", "https://localhost:3000", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/ws", nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			if got := checkOrigin(req); got != tt.want {
				t.Fatalf("checkOrigin(%q) = %v, want %v", tt.origin, got, tt.want)
			}
		})
	}
}
