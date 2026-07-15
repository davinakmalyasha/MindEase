package hub

import (
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

func TestAuthenticate(t *testing.T) {
	token := "not-a-jwt"
	if _, err := Authenticate(token); err == nil {
		t.Fatal("expected error for invalid token")
	}
	if _, err := Authenticate(""); err == nil {
		t.Fatal("expected error for empty token")
	}
}
