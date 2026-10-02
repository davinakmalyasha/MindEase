package hub

import (
	"testing"
	"time"
)

func TestDropStatsCountSeparatesClinicalFromCosmetic(t *testing.T) {
	h := New(DefaultLimits())
	// Unbuffered and never drained: the send is never ready, so every publish
	// takes the drop path. That is the slow-consumer case by construction, and it
	// is what the counters exist to make visible.
	stalled := &Client{ID: 1, Send: make(chan Event)}
	if err := h.Register(1, stalled); err != nil {
		t.Fatalf("register: %v", err)
	}

	h.PublishToUser(1, Event{Type: "message:new"})
	h.PublishToUser(1, Event{Type: "risk:new"})
	h.PublishToUser(1, Event{Type: "typing"})
	h.PublishToUser(1, Event{Type: "typing"})

	drops := h.DropStats()
	if drops.Critical != 2 {
		t.Fatalf("expected 2 critical drops, got %d", drops.Critical)
	}
	if drops.Cosmetic != 2 {
		t.Fatalf("expected 2 cosmetic drops, got %d", drops.Cosmetic)
	}
}

func TestDropStatsZeroWhenEveryConsumerKeepsUp(t *testing.T) {
	h := New(DefaultLimits())
	c := &Client{ID: 7, Send: make(chan Event, 8)}

	if err := h.Register(7, c); err != nil {
		t.Fatalf("register: %v", err)
	}
	for i := 0; i < 4; i++ {
		h.PublishToUser(7, Event{Type: "message:new"})
	}

	drops := h.DropStats()
	if drops.Critical != 0 || drops.Cosmetic != 0 {
		t.Fatalf("expected no drops for a keeping-up consumer, got %+v", drops)
	}
	// And the events actually arrived, so the zero above is not vacuous.
	for i := 0; i < 4; i++ {
		select {
		case <-c.Send:
		case <-time.After(time.Second):
			t.Fatalf("event %d was not delivered", i)
		}
	}
}

func TestDropStatsCountedPerConnection(t *testing.T) {
	// One healthy tab and one stalled tab. Only the stalled one should drop, which
	// is the case a single global counter would get wrong - it would look like the
	// whole user is affected when only one socket is.
	h := New(Limits{MaxPerUser: 5, MaxTotal: 100})
	healthy := &Client{ID: 1, Send: make(chan Event, 4)}
	stalled := &Client{ID: 1, Send: make(chan Event)}
	if err := h.Register(1, healthy); err != nil {
		t.Fatalf("register healthy: %v", err)
	}
	if err := h.Register(1, stalled); err != nil {
		t.Fatalf("register stalled: %v", err)
	}

	h.PublishToUser(1, Event{Type: "risk:new"})

	if got := len(healthy.Send); got != 1 {
		t.Fatalf("healthy connection should have received the event, buffer=%d", got)
	}
	if got := h.DropStats().Critical; got != 1 {
		t.Fatalf("expected exactly 1 critical drop (the stalled socket), got %d", got)
	}
}

func TestIsCriticalClassification(t *testing.T) {
	critical := []string{"message:new", "risk:new", "risk:updated", "appointment:new", "crisis"}
	cosmetic := []string{"typing", "presence", "heartbeat"}

	for _, name := range critical {
		if !IsCritical(name) {
			t.Errorf("expected %q to be critical", name)
		}
	}
	for _, name := range cosmetic {
		if IsCritical(name) {
			t.Errorf("expected %q to be cosmetic", name)
		}
	}
}
