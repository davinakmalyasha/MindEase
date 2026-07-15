package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mindease/realtime/hub"
	"github.com/redis/go-redis/v9"
)

const eventChannel = "mindease:events"

// redisEvent is the payload published by the Node API.
type redisEvent struct {
	UserID int64           `json:"userId"`
	Type   string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	redisAddr := os.Getenv("REDIS_URL")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}

	ctx := context.Background()
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})

	h := hub.New()

	// Subscribe to events published by the Node API.
	sub := rdb.Subscribe(ctx, eventChannel)
	go consumeEvents(ctx, sub, h)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":       "ok",
			"connected":    h.UserCount(),
			"redisChannel": eventChannel,
		})
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
	sub.Close()
	shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
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

// parseUserID is a small helper used by tests.
func parseUserID(s string) (int64, error) {
	return strconv.ParseInt(s, 10, 64)
}
