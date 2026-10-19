// Package db opens the MySQL connection pool and exposes the small helpers
// every domain uses. Queries stay hand-written SQL against the same schema
// Prisma owns; there is no ORM layer to translate behavior through.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// Open parses a Prisma-style `mysql://user:pass@host:port/db` URL and returns
// a configured pool. Times are scanned as UTC, matching what Prisma writes.
func Open(databaseURL string) (*sql.DB, error) {
	dsn, err := DSN(databaseURL)
	if err != nil {
		return nil, err
	}
	pool, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(20)
	pool.SetMaxIdleConns(10)
	pool.SetConnMaxLifetime(30 * time.Minute)
	pool.SetConnMaxIdleTime(5 * time.Minute)
	return pool, nil
}

// DSN converts the configured URL into a go-sql-driver DSN. Exported because
// the migration runner needs the same parsing with one extra option
// (`multiStatements`), which the serving pool must not carry.
func DSN(databaseURL string) (string, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("invalid DATABASE_URL: %w", err)
	}
	if u.Scheme != "mysql" {
		// Allow a raw go-sql-driver DSN to pass through unchanged.
		if strings.Contains(databaseURL, "@tcp(") {
			return databaseURL, nil
		}
		return "", fmt.Errorf("DATABASE_URL must use the mysql:// scheme")
	}
	pass, _ := u.User.Password()
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd = pass
	host := u.Host
	if !strings.Contains(host, ":") {
		host += ":3306"
	}
	cfg.Net = "tcp"
	cfg.Addr = host
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Collation = "utf8mb4_unicode_ci"
	cfg.Params = map[string]string{"charset": "utf8mb4"}
	return cfg.FormatDSN(), nil
}

// Ping retries briefly so the API can start alongside MySQL in compose.
func Ping(ctx context.Context, pool *sql.DB, attempts int) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = pool.PingContext(ctx); err == nil {
			return nil
		}
		time.Sleep(time.Duration(i+1) * 500 * time.Millisecond)
	}
	return err
}
