package hub

import (
	"sync"
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

	// The two publishes that must be counted as clinical are `sos:alert` and
	// `risk:alert`. `risk:new` was used here before `criticalTypes` was corrected,
	// and this assertion is what would have caught the map being wrong in the other
	// direction - if the classification were ever narrowed, the drop would stop being
	// counted as critical and this test would say so.
	h.PublishToUser(1, Event{Type: "message:new"})
	h.PublishToUser(1, Event{Type: "sos:alert"})
	h.PublishToUser(1, Event{Type: "typing:start"})
	h.PublishToUser(1, Event{Type: "typing:stop"})

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

	// A risk disclosure: the event whose loss is the reason the counters exist.
	h.PublishToUser(1, Event{Type: "risk:alert"})

	if got := len(healthy.Send); got != 1 {
		t.Fatalf("healthy connection should have received the event, buffer=%d", got)
	}
	if got := h.DropStats().Critical; got != 1 {
		t.Fatalf("expected exactly 1 critical drop (the stalled socket), got %d", got)
	}
}

// TestDropCountersUnderConcurrentPublishers exists because every other test in
// this file publishes from one goroutine, and the counter increment is not
// protected for more than one.
//
// `PublishToUser` holds `h.mu.RLock()` - a *read* lock, which many publishers may
// hold at once - and increments `h.droppedCritical` inside it. The comment there
// claimed "the write lock we already hold", which is the kind of sentence that
// stops a reader checking. Two publishers that both hit the slow-consumer path
// are two unsynchronised writes to the same `uint64`: a data race, and lost
// increments, on the counters that exist specifically to make a lost clinical
// alert visible.
//
// The test is meaningful only under `-race`, which CI runs. Without the detector
// it is still worth having: lost increments make the total come out short.
func TestDropCountersUnderConcurrentPublishers(t *testing.T) {
	h := New(DefaultLimits())
	// Unbuffered and never drained, so every publish takes the drop path - the
	// slow-consumer case by construction rather than by timing.
	stalled := &Client{ID: 1, Send: make(chan Event)}
	if err := h.Register(1, stalled); err != nil {
		t.Fatalf("register: %v", err)
	}

	const publishers = 8
	const each = 100

	var wg sync.WaitGroup
	for i := 0; i < publishers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < each; j++ {
				// A mix, so both counters are exercised concurrently.
				if j%2 == 0 {
					h.PublishToUser(1, Event{Type: "risk:alert"})
				} else {
					h.PublishToUser(1, Event{Type: "typing:start"})
				}
			}
		}()
	}
	wg.Wait()

	drops := h.DropStats()
	want := uint64(publishers * each / 2)
	if drops.Critical != want {
		t.Errorf("critical drops: want %d, got %d (increments were lost)", want, drops.Critical)
	}
	if drops.Cosmetic != want {
		t.Errorf("cosmetic drops: want %d, got %d (increments were lost)", want, drops.Cosmetic)
	}
}

// TestIsCriticalClassification pins the classification to the event types that
// actually exist.
//
// The previous version asserted that `risk:new`, `risk:updated`, `crisis`,
// `appointment:new` and `appointment:update` were critical. None of them is
// published by anything in the repository, and the two that are - `sos:alert` and
// `risk:alert` - were not in the list, so a dropped SOS press or risk disclosure
// was counted as cosmetic. The test was internally consistent and externally
// wrong, which is why it passed: it duplicated the map instead of comparing it to
// the TypeScript union.
//
// server/tests/realtime-contract.test.ts now compares `criticalTypes` to
// `RealtimeEventType` directly, and it lives in the TypeScript suite because the
// union is written there. This test keeps the Go-side assertions on the
// classification itself, including the direction that matters most.
func TestIsCriticalClassification(t *testing.T) {
	// The events this service exists to deliver. A clinician is paged by these;
	// counting one as cosmetic is the failure the counters were built to catch.
	critical := []string{
		"sos:alert",
		"risk:alert",
		"message:new",
		"appointment:join",
		"notification:new",
	}

	// Presentational: read receipts and typing indicators are safe to lose,
	// because the next poll or the next keystroke renders the same truth.
	cosmetic := []string{
		"typing:start",
		"typing:stop",
		"message:read",
		"message:deleted",
		"message:reacted",
	}

	// Names nothing publishes, from the previous list. If any of these ever
	// becomes real, the contract test fails and the map has to be revisited.
	retired := []string{
		"risk:new",
		"risk:updated",
		"crisis",
		"appointment:new",
		"appointment:update",
	}

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
	for _, name := range retired {
		if IsCritical(name) {
			t.Errorf("%q is not published by anything; classifying it hides real drops", name)
		}
	}
}
