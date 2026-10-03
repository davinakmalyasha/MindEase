package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mindease/realtime/hub"
	"github.com/redis/go-redis/v9"
)

const eventChannel = "mindease:events"

// redisOptions turns REDIS_URL into go-redis options.
//
// The Node API takes REDIS_URL as a URL (createClient({ url })), so every place
// this value is set — docker-compose, .env.example, Railway — supplies a URL like
// `redis://default:pass@host:6379`. `redis.Options.Addr`, by contrast, wants a
// bare `host:port` dial string. Passing the URL straight through made this
// service dial a host literally named "redis://redis:6379", fail, and then
// subscribe to a channel on a connection that never established — silently,
// because go-redis only reports that through a logger that defaults to a no-op.
//
// Accept both forms so a bare `host:port` (the shape the old fallback used) still
// works, and so a misconfiguration fails loudly at boot rather than as a silent
// realtime outage.
func redisOptions(raw string) (*redis.Options, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = "localhost:6379"
	}

	// A bare host:port (or unix socket) is not a URL; treat it as a dial string.
	if !strings.Contains(raw, "://") {
		return &redis.Options{Addr: raw}, nil
	}

	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("REDIS_URL is not a valid URL: %w", err)
	}
	if u.Scheme != "redis" && u.Scheme != "rediss" {
		return nil, fmt.Errorf("REDIS_URL scheme %q is not supported (want redis:// or rediss://)", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("REDIS_URL %q has no host", raw)
	}

	opts := &redis.Options{Addr: u.Host}
	if u.User != nil {
		if pass, ok := u.User.Password(); ok {
			opts.Password = pass
		}
		if name := u.User.Username(); name != "" && name != "default" {
			opts.Username = name
		}
	}
	// A query like `?db=2` or `?tls=true` is a legitimate operational need.
	if db := u.Query().Get("db"); db != "" {
		n, err := strconv.Atoi(db)
		if err != nil {
			return nil, fmt.Errorf("REDIS_URL db parameter %q is not a number", db)
		}
		opts.DB = n
	}
	if u.Scheme == "rediss" || u.Query().Get("tls") == "true" {
		opts.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	return opts, nil
}

// redisEvent is the payload published by the Node API.
type redisEvent struct {
	UserID  int64           `json:"userId"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// connectionLimits reads the connection caps from the environment.
//
// Both default to the package defaults when unset, and a non-numeric or
// non-positive value is ignored rather than applied, so a typo cannot silently
// disable the cap (hub.New applies the same guard).
func connectionLimits() hub.Limits {
	l := hub.DefaultLimits()
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("MAX_CONNECTIONS_PER_USER"))); err == nil && v > 0 {
		l.MaxPerUser = v
	}
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("MAX_TOTAL_CONNECTIONS"))); err == nil && v > 0 {
		l.MaxTotal = v
	}
	return l
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	redisURL := os.Getenv("REDIS_URL")

	opts, err := redisOptions(redisURL)
	if err != nil {
		log.Fatalf("realtime: %v", err)
	}

	ctx := context.Background()
	rdb := redis.NewClient(opts)
	if err := rdb.Ping(ctx).Err(); err != nil {
		// This used to be fatal-by-silence: the service stayed up, /health stayed
		// green, and every browser sat in a reconnect loop. If Redis is unreachable
		// there is nothing this process can do, so say so and exit.
		log.Fatalf("realtime: cannot reach Redis at %s: %v", opts.Addr, err)
	}
	log.Printf("realtime: connected to Redis at %s", opts.Addr)

	limits := connectionLimits()
	h := hub.New(limits)
	log.Printf("realtime: connection caps per-user=%d total=%d", limits.MaxPerUser, limits.MaxTotal)

	// Subscribe to events published by the Node API.
	sub := rdb.Subscribe(ctx, eventChannel)
	go consumeEvents(ctx, sub, h)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		// Report a real dependency status. This endpoint used to answer "ok"
		// unconditionally, which meant a total realtime outage looked healthy to
		// compose, Railway and any uptime monitor while every browser sat in a
		// reconnect loop. A subscriber with no Redis is not healthy.
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		redisErr := rdb.Ping(ctx).Err()

		w.Header().Set("Content-Type", "application/json")
		body := map[string]any{
			"status":       "ok",
			"connected":    h.UserCount(),
			"connections":  h.ConnectionCount(),
			"maxPerUser":   limits.MaxPerUser,
			"maxTotal":     limits.MaxTotal,
			"redisChannel": eventChannel,
		}

		// Event drops, broken out by class.
		//
		// The hub drops rather than blocks when a socket's buffer is full, which is
		// the correct trade - one slow client must not stall every other user - but
		// it was invisible. A dropped `message:new` or `risk:new` is a message or a
		// risk alert that never arrived, and without this the only symptom was a
		// user reporting that nobody replied. Surfaced on the health endpoint
		// because that is already polled, so the number costs nothing to read.
		drops := h.DropStats()
		body["dropped"] = map[string]uint64{
			"critical": drops.Critical,
			"cosmetic": drops.Cosmetic,
		}

		if redisErr != nil {
			body["status"] = "degraded"
			body["error"] = "redis unreachable"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		// Error-checked, not ignored. `WriteHeader` has already committed a 200 or
		// a 503 by this point, so the only remaining action is to record it - but
		// record it, because a health endpoint that silently returns `{}` looks
		// exactly like a healthy one to a probe.
		if err := json.NewEncoder(w).Encode(body); err != nil {
			log.Printf("health: encoding response failed: %v", err)
		}
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("MindEase realtime service listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("shutting down...")
	if err := sub.Close(); err != nil {
		log.Printf("shutdown: closing redis subscription failed: %v", err)
	}
	shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v (clients still connected were force-closed)", err)
	}
}

func consumeEvents(ctx context.Context, sub *redis.PubSub, h *hub.Hub) {
	ch := sub.Channel()
	for msg := range ch {
		var ev redisEvent
		if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
			log.Printf("bad event payload: %v", err)
			continue
		}

		var payload any
		if len(ev.Payload) > 0 {
			if err := json.Unmarshal(ev.Payload, &payload); err != nil {
				log.Printf("bad event payload data: %v", err)
				continue
			}
		}

		h.PublishToUser(ev.UserID, hub.Event{Type: ev.Type, Payload: payload})
	}
}
