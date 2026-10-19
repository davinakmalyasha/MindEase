// Command migrate applies the schema history embedded in the binary.
//
// It is the only migration runner: docker-compose runs it as a one-shot before
// the API starts, and it can be run by hand with DATABASE_URL set.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/davinakmalyasha/MindEase/server-go/internal/migrate"
	"github.com/davinakmalyasha/MindEase/server-go/migrations"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(1)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := migrate.Run(ctx, databaseURL, migrations.FS, logger); err != nil {
		logger.Error("migration failed", "err", err)
		os.Exit(1)
	}
}
