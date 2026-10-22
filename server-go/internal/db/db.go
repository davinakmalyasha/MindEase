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

// Options controls the per-process connection pool. MaxOpen is multiplied by
// the number of API replicas, so the deployment's total must stay below the
// database's max_connections (151 by default in MySQL 8).
type Options struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
	// TLS is passed through to go-sql-driver: "true" (verify), "skip-verify",
	// "preferred", or "false"/"" for plaintext. The serving pool should use
	// "true" against a managed database.
	TLS string
}

// DefaultOptions returns the pool settings the Go port started with.
func DefaultOptions() Options {
	return Options{
		MaxOpenConns:    20,
		MaxIdleConns:    10,
		ConnMaxLifetime: 30 * time.Minute,
		ConnMaxIdleTime: 5 * time.Minute,
	}
}

// Validate rejects a pool that could exhaust the database or never recycle a
// connection. It runs before any dial, so a bad configuration is a boot error.
func (o Options) Validate() error {
	if o.MaxOpenConns <= 0 {
		return fmt.Errorf("db: MaxOpenConns must be positive")
	}
	if o.MaxIdleConns < 0 || o.MaxIdleConns > o.MaxOpenConns {
		return fmt.Errorf("db: MaxIdleConns must be between 0 and MaxOpenConns")
	}
	if o.ConnMaxLifetime <= 0 || o.ConnMaxIdleTime <= 0 {
		return fmt.Errorf("db: connection lifetimes must be positive")
	}
	switch o.TLS {
	case "", "true", "false", "preferred", "skip-verify":
	default:
		return fmt.Errorf("db: unsupported TLS mode %q", o.TLS)
	}
	return nil
}

// Open parses a Prisma-style `mysql://user:pass@host:port/db` URL and returns
// a configured pool. Times are scanned as UTC, matching what Prisma writes.
func Open(databaseURL string) (*sql.DB, error) {
	return OpenWithOptions(databaseURL, DefaultOptions())
}

// OpenWithOptions is Open with an explicit pool configuration.
func OpenWithOptions(databaseURL string, opts Options) (*sql.DB, error) {
	if err := opts.Validate(); err != nil {
		return nil, err
	}
	dsn, err := DSNWithOptions(databaseURL, opts.TLS)
	if err != nil {
		return nil, err
	}
	pool, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(opts.MaxOpenConns)
	pool.SetMaxIdleConns(opts.MaxIdleConns)
	pool.SetConnMaxLifetime(opts.ConnMaxLifetime)
	pool.SetConnMaxIdleTime(opts.ConnMaxIdleTime)
	return pool, nil
}

// DSN converts the configured URL into a go-sql-driver DSN. Exported because
// the migration runner needs the same parsing with one extra option
// (`multiStatements`), which the serving pool must not carry.
func DSN(databaseURL string) (string, error) {
	return DSNWithOptions(databaseURL, "")
}

// DSNWithOptions is DSN with a MySQL TLS mode applied. A raw go-sql-driver
// DSN cannot be combined with a separate TLS mode: the setting belongs inside
// that DSN, and silently dropping it would be a security surprise.
func DSNWithOptions(databaseURL, tlsMode string) (string, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("invalid DATABASE_URL: %w", err)
	}
	if u.Scheme != "mysql" {
		// Allow a raw go-sql-driver DSN to pass through unchanged.
		if strings.Contains(databaseURL, "@tcp(") {
			if tlsMode != "" && tlsMode != "false" {
				return "", fmt.Errorf("DATABASE_TLS cannot be combined with a raw DSN; add tls=%s to the DSN instead", tlsMode)
			}
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
	if tlsMode != "" && tlsMode != "false" {
		cfg.TLSConfig = tlsMode
	}
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
