package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
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

func TestRateLimitWindowExpiresAndResets(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	key := fmt.Sprintf("expiry-%d", time.Now().UnixNano())
	window := 60 * time.Millisecond

	if count, reset := s.bump("general", key, window, 1); count != 1 || reset < 0 {
		t.Fatalf("first bump = %d/%d; want 1/non-negative reset", count, reset)
	}
	if count, _ := s.bump("general", key, window, 1); count != 2 {
		t.Fatalf("second bump = %d; want 2 (same fixed window)", count)
	}
	time.Sleep(80 * time.Millisecond)
	if count, _ := s.bump("general", key, window, 1); count != 1 {
		t.Fatalf("post-window bump = %d; want 1 (window reset)", count)
	}
}

func TestRateLimitDecrementClampsAtZero(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	key := fmt.Sprintf("decrement-%d", time.Now().UnixNano())
	window := 500 * time.Millisecond

	for i := 1; i <= 3; i++ {
		if count, _ := s.bump("auth", key, window, 1); count != i {
			t.Fatalf("increment %d: count = %d", i, count)
		}
	}
	// One decrement from 3 lands on 2.
	if count, _ := s.bump("auth", key, window, -1); count != 2 {
		t.Fatalf("after one decrement = %d; want 2", count)
	}
	// Drain to zero and past it: the counter clamps, never negative.
	var count int
	for i := 0; i < 5; i++ {
		count, _ = s.bump("auth", key, window, -1)
	}
	if count != 0 {
		t.Fatalf("over-decremented counter = %d; want clamp at 0", count)
	}
}

func TestRateLimitDecrementDoesNotRefreshWindow(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	key := fmt.Sprintf("no-refresh-%d", time.Now().UnixNano())
	window := 120 * time.Millisecond

	if count, _ := s.bump("auth", key, window, 1); count != 1 {
		t.Fatalf("first = %d; want 1", count)
	}
	time.Sleep(70 * time.Millisecond)
	// A successful-login decrement must not push the window out: after another
	// 70ms the original window has elapsed and the next increment restarts at 1.
	s.bump("auth", key, window, -1)
	time.Sleep(70 * time.Millisecond)
	if count, _ := s.bump("auth", key, window, 1); count != 1 {
		t.Fatalf("post-window count = %d; want 1 (decrement must not extend)", count)
	}
}

func TestRateLimitConcurrentBumpsAreExact(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	key := fmt.Sprintf("concurrent-%d", time.Now().UnixNano())
	const n = 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.bump("general", key, time.Minute, 1)
		}()
	}
	wg.Wait()
	if count, _ := s.bump("general", key, time.Minute, 0); count != n {
		t.Fatalf("concurrent count = %d; want %d", count, n)
	}
}

func TestRateLimitMiddleware429AndHeaders(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := s.limiter(rateLimitConfig{name: "test429", window: time.Minute, max: 2, message: "slow down"})(next)

	doReq := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/test429", nil)
		req.RemoteAddr = "9.9.9.9:1234"
		h.ServeHTTP(rec, req)
		return rec
	}
	r1 := doReq()
	r2 := doReq()
	r3 := doReq()
	if r1.Code != http.StatusOK || r2.Code != http.StatusOK {
		t.Fatalf("first two = %d/%d; want 200/200", r1.Code, r2.Code)
	}
	if r3.Code != http.StatusTooManyRequests {
		t.Fatalf("third = %d; want 429", r3.Code)
	}
	if got := r3.Header().Get("RateLimit-Limit"); got != "2" {
		t.Fatalf("RateLimit-Limit = %q; want 2", got)
	}
	if got := r3.Header().Get("RateLimit-Remaining"); got != "0" {
		t.Fatalf("RateLimit-Remaining = %q; want 0", got)
	}
	if got := r3.Header().Get("RateLimit-Reset"); got == "" {
		t.Fatal("RateLimit-Reset header missing on 429")
	}
}

func TestRateLimitSkipSuccessfulOnlyCountsFailures(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fail" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	h := s.limiter(rateLimitConfig{name: "testskip", window: time.Minute, max: 2, message: "slow down", skipSuccessful: true})(next)

	ok := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "8.8.8.8:1234"
		h.ServeHTTP(rec, req)
		return rec
	}
	// Five successes must not consume budget: each is decremented back.
	for i := 0; i < 5; i++ {
		if rec := ok("/ok"); rec.Code != http.StatusOK {
			t.Fatalf("success %d = %d; want 200", i, rec.Code)
		}
	}
	// Two failures consume the budget of 2; the third trips 429.
	if rec := ok("/fail"); rec.Code != http.StatusBadRequest {
		t.Fatalf("fail 1 = %d; want 400", rec.Code)
	}
	if rec := ok("/fail"); rec.Code != http.StatusBadRequest {
		t.Fatalf("fail 2 = %d; want 400", rec.Code)
	}
	if rec := ok("/fail"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("fail 3 = %d; want 429", rec.Code)
	}
}

func TestRateLimitGeneralExemptsHealthAndInternal(t *testing.T) {
	resetRateLimitMem()
	s := testServer()
	var hits int
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	})
	h := s.generalLimiter()(next)
	for _, path := range []string{"/api/health", "/api/health/db", "/api/readyz", "/api/csrf-token", "/api/internal/jobs/reminders"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "7.7.7.7:1234"
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d; want 200", path, rec.Code)
		}
		if rec.Header().Get("RateLimit-Limit") != "" {
			t.Fatalf("GET %s set RateLimit headers; exempt paths must bypass", path)
		}
	}
	if hits != 5 {
		t.Fatalf("exempt hits = %d; want 5", hits)
	}
}
