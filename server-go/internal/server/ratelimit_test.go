package server

import (
	"fmt"
	"testing"
	"time"
)

func TestRateLimitCountersAreIsolatedPerLimiterName(t *testing.T) {
	s := testServer()
	key := fmt.Sprintf("isolation-%d", time.Now().UnixNano())

	if count, _ := s.bump("auth", key, time.Minute, 1); count != 1 {
		t.Fatalf("auth first count = %d; want 1", count)
	}
	// A different limiter with the same subject starts its own counter. This is
	// the property the store's `prefix` exists for: stacked limiters must not
	// share a budget.
	if count, _ := s.bump("general", key, time.Minute, 1); count != 1 {
		t.Fatalf("general first count = %d; want 1 (shared budget with auth)", count)
	}
	if count, _ := s.bump("auth", key, time.Minute, 1); count != 2 {
		t.Fatalf("auth second count = %d; want 2", count)
	}
	// The successful-request decrement applies to its own counter only.
	if count, _ := s.bump("auth", key, time.Minute, -1); count != 1 {
		t.Fatalf("auth after decrement = %d; want 1", count)
	}
	if count, _ := s.bump("general", key, time.Minute, 1); count != 2 {
		t.Fatalf("general second count = %d; want 2", count)
	}
}
