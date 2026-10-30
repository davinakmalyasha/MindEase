package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// rateLimitConfig mirrors the sharedLimiter construction in
// middleware/rateLimit.middleware.ts: every limiter has a name (its counter
// namespace), a window, a ceiling and a message.
type rateLimitConfig struct {
	name           string
	window         time.Duration
	max            int
	message        string
	skipSuccessful bool
	key            func(*http.Request) string
}

func (s *Server) limiter(cfg rateLimitConfig) func(http.Handler) http.Handler {
	keyFor := cfg.key
	if keyFor == nil {
		keyFor = func(r *http.Request) string { return "ip:" + remoteIP(r, s.Cfg.IsProd) }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.Cfg.IsTest {
				next.ServeHTTP(w, r)
				return
			}
			key := keyFor(r)
			count, reset := s.bump(cfg.name, key, cfg.window, 1)
			w.Header().Set("RateLimit-Limit", fmt.Sprintf("%d", cfg.max))
			w.Header().Set("RateLimit-Remaining", fmt.Sprintf("%d", max(0, cfg.max-count)))
			w.Header().Set("RateLimit-Reset", fmt.Sprintf("%d", reset))
			if count > cfg.max {
				s.Fail(w, http.StatusTooManyRequests, cfg.message)
				return
			}
			if !cfg.skipSuccessful {
				next.ServeHTTP(w, r)
				return
			}
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if rec.status < 400 {
				s.bump(cfg.name, key, cfg.window, -1)
			}
		})
	}
}

// generalLimiter: 300 requests / 15 min / IP, exempting health, csrf
// bootstrap and the internal worker trigger, exactly like app.ts.
func (s *Server) generalLimiter() func(http.Handler) http.Handler {
	limit := s.limiter(rateLimitConfig{
		name:    "general",
		window:  15 * time.Minute,
		max:     300,
		message: "Too many requests, please slow down",
		key: func(r *http.Request) string {
			return "ip:" + remoteIP(r, s.Cfg.IsProd)
		},
	})
	return func(next http.Handler) http.Handler {
		guarded := limit(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			if strings.HasPrefix(path, "/api/health") ||
				path == "/api/readyz" ||
				path == "/api/csrf-token" ||
				strings.HasPrefix(path, "/api/internal") {
				next.ServeHTTP(w, r)
				return
			}
			guarded.ServeHTTP(w, r)
		})
	}
}

// bump increments the counter for (name, key) and returns the new value and
// seconds until the window resets. Redis is the shared store; when it is
// unavailable the in-process fallback keeps limits meaningful on one replica
// and a log line records the degradation.
//
// Both stores are fixed-window: the TTL is set only when the key is newly
// created (count == delta), never refreshed by sustained traffic. Refreshing
// on every increment would slide the window indefinitely under load, which is
// why the mem store sets resetAt once. Decrements (skipSuccessful auth path)
// never extend the window.
func (s *Server) bump(name, key string, window time.Duration, delta int) (int, int) {
	fullKey := "mindease:go:rl:" + name + ":" + key
	if s.Redis != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		count, err := s.Redis.IncrBy(ctx, fullKey, int64(delta)).Result()
		if err == nil {
			if count == int64(delta) {
				s.Redis.Expire(ctx, fullKey, window)
			}
			ttl, _ := s.Redis.TTL(ctx, fullKey).Result()
			reset := int(window / time.Second)
			if ttl > 0 {
				reset = int(ttl / time.Second)
			}
			return int(count), reset
		}
		s.Log.Warn("rate limit redis unavailable; using in-process counter", "limiter", name, "err", err)
		if s.metrics != nil {
			s.metrics.rateLimitFallbacks.Inc()
		}
	}
	return memBump(fullKey, window, delta)
}

var (
	memMu       sync.Mutex
	memCounters = map[string]*memCounter{}
)

type memCounter struct {
	count   int
	resetAt time.Time
}

func memBump(key string, window time.Duration, delta int) (int, int) {
	memMu.Lock()
	defer memMu.Unlock()
	now := time.Now()
	c, ok := memCounters[key]
	if !ok || now.After(c.resetAt) {
		c = &memCounter{resetAt: now.Add(window)}
		memCounters[key] = c
	}
	c.count += delta
	if c.count < 0 {
		c.count = 0
	}
	// Bound growth: distinct keys (IPs, emails) accumulate forever otherwise.
	// A cheap opportunistic sweep when the map gets large deletes only keys
	// whose window has already elapsed, never live counters.
	if len(memCounters) > 5000 {
		for k, v := range memCounters {
			if now.After(v.resetAt) {
				delete(memCounters, k)
			}
		}
	}
	return c.count, int(time.Until(c.resetAt) / time.Second)
}

// resetRateLimitMem clears the in-process fallback. Tests only: the store is
// global so one test's counters would otherwise bleed into the next.
func resetRateLimitMem() {
	memMu.Lock()
	defer memMu.Unlock()
	memCounters = map[string]*memCounter{}
}
