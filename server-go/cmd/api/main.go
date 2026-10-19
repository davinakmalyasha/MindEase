package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"

	"github.com/redis/go-redis/v9"

	"github.com/davinakmalyasha/MindEase/server-go/internal/config"
	"github.com/davinakmalyasha/MindEase/server-go/internal/db"
	"github.com/davinakmalyasha/MindEase/server-go/internal/server"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	// Error tracking is opt-in: without a DSN, sentry-go keeps a client-less hub
	// and every capture is a no-op, which is what tests and local runs rely on.
	if dsn := strings.TrimSpace(os.Getenv("SENTRY_DSN")); dsn != "" {
		if err := sentry.Init(sentry.ClientOptions{Dsn: dsn, TracesSampleRate: 0}); err != nil {
			logger.Warn("sentry init failed", "err", err)
		} else {
			defer sentry.Flush(2 * time.Second)
		}
	}

	pool, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer pool.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := db.Ping(ctx, pool, 10); err != nil {
		logger.Error("database unreachable", "err", err)
		os.Exit(1)
	}

	var rdb *redis.Client
	if cfg.RedisURL != "" {
		opt, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			logger.Error("invalid REDIS_URL", "err", err)
			os.Exit(1)
		}
		rdb = redis.NewClient(opt)
		if err := rdb.Ping(ctx).Err(); err != nil {
			logger.Warn("redis unreachable; continuing with degraded features", "err", err)
			rdb = nil
		}
	}

	if err := os.MkdirAll(cfg.UploadDir, 0o755); err != nil {
		logger.Error("cannot create upload dir", "err", err)
		os.Exit(1)
	}

	srv := server.New(cfg, pool, rdb, logger)

	go srv.StartJobs(ctx)

	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           srv.Mount(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Info("api listening", "port", cfg.Port, "prod", cfg.IsProd)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
	}
	logger.Info("api stopped")
}
