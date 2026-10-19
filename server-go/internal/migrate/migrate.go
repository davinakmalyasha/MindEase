// Package migrate applies the embedded schema history.
package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"strconv"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/davinakmalyasha/MindEase/server-go/internal/db"
)

// Run applies every migration the database has not seen.
//
// A database created by the old runner has all the tables but records them in
// Prisma's `_prisma_migrations` table, not golang-migrate's
// `schema_migrations`. Running `Up` there would replay the history against an
// existing schema. Instead the runner reads the highest version Prisma
// finished and records it as the baseline (`Force`), then applies whatever
// came after. Fresh databases, and databases already on `schema_migrations`,
// simply run up.
func Run(ctx context.Context, databaseURL string, files fs.FS, log *slog.Logger) error {
	dsn, err := db.DSN(databaseURL)
	if err != nil {
		return err
	}
	// Multi-statement support is required: each migration file is a single
	// Exec of everything Prisma wrote there. The serving pool deliberately
	// does not set this.
	if strings.Contains(dsn, "?") {
		dsn += "&multiStatements=true"
	} else {
		dsn += "?multiStatements=true"
	}
	pool, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.PingContext(ctx); err != nil {
		return fmt.Errorf("database unreachable: %w", err)
	}

	name, err := databaseName(databaseURL)
	if err != nil {
		return err
	}
	// The baseline decision must happen BEFORE the driver is constructed:
	// golang-migrate's MySQL driver creates `schema_migrations` eagerly, so
	// checking afterwards would always find the runner's table and never the
	// Prisma one.
	baseline, version, err := prismaBaseline(ctx, pool)
	if err != nil {
		return err
	}

	driver, err := mysql.WithInstance(pool, &mysql.Config{
		DatabaseName:    name,
		MigrationsTable: "schema_migrations",
	})
	if err != nil {
		return err
	}
	source, err := iofs.New(files, ".")
	if err != nil {
		return err
	}
	m, err := migrate.NewWithInstance("iofs", source, "mysql", driver)
	if err != nil {
		return err
	}
	defer m.Close()

	if baseline {
		log.Warn("database was built by Prisma; recording its finished version before applying the rest",
			"version", version)
		if err := m.Force(int(version)); err != nil {
			return fmt.Errorf("baseline to version %d: %w", version, err)
		}
	}

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	current, dirty, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return err
	}
	log.Info("schema is current", "version", current, "dirty", dirty)
	return nil
}

// prismaBaseline reports whether the database predates this runner and, if so,
// the highest migration version Prisma finished. A failed row is ignored; a
// history with nothing finished returns false so the migrations run from zero.
//
// A `schema_migrations` table that already holds a version means this runner
// owns the database, whatever else is lying around. An empty one (left by an
// interrupted first attempt) is treated as unowned.
func prismaBaseline(ctx context.Context, pool *sql.DB) (bool, uint64, error) {
	var hasPrisma int
	err := pool.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_prisma_migrations'`).Scan(&hasPrisma)
	if err != nil {
		return false, 0, err
	}
	if hasPrisma == 0 {
		return false, 0, nil
	}

	var recorded int
	err = pool.QueryRowContext(ctx, "SELECT COUNT(*) FROM `schema_migrations`").Scan(&recorded)
	if err == nil && recorded > 0 {
		return false, 0, nil
	}
	if err != nil && !isMissingTable(err) {
		return false, 0, err
	}

	rows, err := pool.QueryContext(ctx,
		"SELECT migration_name FROM `_prisma_migrations` "+
			"WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
	if err != nil {
		return false, 0, err
	}
	defer rows.Close()

	var highest uint64
	for rows.Next() {
		var migrationName string
		if err := rows.Scan(&migrationName); err != nil {
			return false, 0, err
		}
		if v := leadingVersion(migrationName); v > highest {
			highest = v
		}
	}
	if err := rows.Err(); err != nil {
		return false, 0, err
	}
	if highest == 0 {
		return false, 0, nil
	}
	return true, highest, nil
}

// isMissingTable matches MySQL error 1146 ("Table ... doesn't exist") without
// importing the driver's error type into this package again.
func isMissingTable(err error) bool {
	return strings.Contains(err.Error(), "1146")
}

func leadingVersion(name string) uint64 {
	digits := name
	if i := strings.IndexByte(name, '_'); i >= 0 {
		digits = name[:i]
	}
	v, err := strconv.ParseUint(digits, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func databaseName(databaseURL string) (string, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("invalid DATABASE_URL: %w", err)
	}
	if u.Scheme == "mysql" {
		name := strings.TrimPrefix(u.Path, "/")
		if name == "" {
			return "", errors.New("DATABASE_URL has no database name")
		}
		return name, nil
	}
	// Raw go-sql-driver DSN: the database is the path segment before `?`.
	rest := databaseURL
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndexByte(rest, '/'); i >= 0 && i < len(rest)-1 {
		return rest[i+1:], nil
	}
	return "", errors.New("DATABASE_URL has no database name")
}
