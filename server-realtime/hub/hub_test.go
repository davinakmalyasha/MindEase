package hub

import (
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestHubRegisterAndPublish(t *testing.T) {
	h := New(DefaultLimits())
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
	h := New(DefaultLimits())
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
	h := New(DefaultLimits())
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
	h := New(DefaultLimits())
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
	h := New(DefaultLimits())
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
	h := New(DefaultLimits())
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

// TestHubPerUserConnectionCap verifies that a single user cannot open an
// unbounded number of sockets. Before the cap existed, Register had no limit
// at all, so one client (or a loop with one token) could exhaust the process
// memory that the per-connection send buffers occupy.
func TestHubPerUserConnectionCap(t *testing.T) {
	h := New(Limits{MaxPerUser: 3, MaxTotal: 1000})

	var accepted []*Client
	for i := 0; i < 3; i++ {
		c := &Client{ID: 1, Send: make(chan Event, 1)}
		if err := h.Register(1, c); err != nil {
			t.Fatalf("connection %d should have been accepted, got %v", i, err)
		}
		accepted = append(accepted, c)
	}

	over := &Client{ID: 1, Send: make(chan Event, 1)}
	if err := h.Register(1, over); err != ErrTooManyConnections {
		t.Fatalf("expected ErrTooManyConnections past the per-user cap, got %v", err)
	}

	// A rejected client must not have been registered, or it would silently
	// become a zombie that never receives unregisters.
	if h.ConnectionCount() != 3 {
		t.Fatalf("rejected client was registered: connection count = %d, want 3", h.ConnectionCount())
	}

	// Freeing a slot lets the user connect again.
	h.Unregister(1, accepted[0])
	if err := h.Register(1, over); err != nil {
		t.Fatalf("expected reconnection to succeed after a slot freed, got %v", err)
	}
}

// TestHubTotalConnectionCap verifies the process-wide ceiling applies across
// users, so a single abusive user hitting the per-user cap still cannot take
// the whole service down.
func TestHubTotalConnectionCap(t *testing.T) {
	h := New(Limits{MaxPerUser: 10, MaxTotal: 4})

	registered := 0
	for userID := int64(1); userID <= 6; userID++ {
		c := &Client{ID: userID, Send: make(chan Event, 1)}
		if err := h.Register(userID, c); err == nil {
			registered++
		}
	}
	if registered != 4 {
		t.Fatalf("expected the total cap to admit 4 connections, admitted %d", registered)
	}
	if h.ConnectionCount() != 4 {
		t.Fatalf("expected connection count 4, got %d", h.ConnectionCount())
	}
}

// TestHubNonPositiveLimitsFallBackToDefaults guards against a misconfigured
// environment silently disabling the caps.
func TestHubNonPositiveLimitsFallBackToDefaults(t *testing.T) {
	h := New(Limits{MaxPerUser: 0, MaxTotal: -1})
	if h.limits.MaxPerUser != DefaultMaxPerUserConnections {
		t.Fatalf("MaxPerUser = %d, want %d", h.limits.MaxPerUser, DefaultMaxPerUserConnections)
	}
	if h.limits.MaxTotal != DefaultMaxTotalConnections {
		t.Fatalf("MaxTotal = %d, want %d", h.limits.MaxTotal, DefaultMaxTotalConnections)
	}
}

// TestHubConcurrentRegisterRespectsCap asserts the cap check and the insert
// happen under one lock, so simultaneous connections cannot both observe the
// last free slot.
func TestHubConcurrentRegisterRespectsCap(t *testing.T) {
	const cap = 5
	h := New(Limits{MaxPerUser: cap, MaxTotal: cap * 10})

	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0

	for i := 0; i < cap*4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := &Client{ID: 99, Send: make(chan Event, 1)}
			if err := h.Register(99, c); err == nil {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if accepted != cap {
		t.Fatalf("accepted %d concurrent connections, want exactly %d", accepted, cap)
	}
	if h.ConnectionCount() != cap {
		t.Fatalf("connection count = %d, want %d", h.ConnectionCount(), cap)
	}
}
