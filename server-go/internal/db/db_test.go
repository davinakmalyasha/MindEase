package db

import (
	"strings"
	"testing"
	"time"
)

func TestDefaultOptionsMatchTheOriginalHardCodedPool(t *testing.T) {
	o := DefaultOptions()
	if o.MaxOpenConns != 20 || o.MaxIdleConns != 10 {
		t.Fatalf("unexpected defaults: %+v", o)
	}
	if o.ConnMaxLifetime != 30*time.Minute || o.ConnMaxIdleTime != 5*time.Minute {
		t.Fatalf("unexpected lifetimes: %+v", o)
	}
	if err := o.Validate(); err != nil {
		t.Fatalf("defaults must validate: %v", err)
	}
}

func TestOptionsRejectUnsafePools(t *testing.T) {
	base := DefaultOptions()

	tooManyIdle := base
	tooManyIdle.MaxIdleConns = tooManyIdle.MaxOpenConns + 1
	if err := tooManyIdle.Validate(); err == nil {
		t.Fatal("idle connections above the open ceiling must be refused")
	}

	zeroOpen := base
	zeroOpen.MaxOpenConns = 0
	if err := zeroOpen.Validate(); err == nil {
		t.Fatal("a zero-sized pool must be refused")
	}

	negativeIdle := base
	negativeIdle.MaxIdleConns = -1
	if err := negativeIdle.Validate(); err == nil {
		t.Fatal("a negative idle ceiling must be refused")
	}

	zeroLifetime := base
	zeroLifetime.ConnMaxLifetime = 0
	if err := zeroLifetime.Validate(); err == nil {
		t.Fatal("a zero connection lifetime must be refused")
	}

	badTLS := base
	badTLS.TLS = "require-but-typo"
	if err := badTLS.Validate(); err == nil {
		t.Fatal("an unknown TLS mode must be refused")
	}
}

func TestDSNCarriesTLSAndUTCParsing(t *testing.T) {
	dsn, err := DSNWithOptions("mysql://user:pass@db.internal:3307/mindease", "skip-verify")
	if err != nil {
		t.Fatalf("DSN: %v", err)
	}
	for _, want := range []string{"tls=skip-verify", "parseTime=true", "charset=utf8mb4"} {
		if !strings.Contains(dsn, want) {
			t.Fatalf("DSN %q is missing %q", dsn, want)
		}
	}

	plain, err := DSN("mysql://user:pass@localhost/mindease")
	if err != nil {
		t.Fatalf("plain DSN: %v", err)
	}
	if strings.Contains(plain, "tls=") {
		t.Fatalf("plain DSN unexpectedly carries TLS: %q", plain)
	}
}

func TestRawDSNCannotBeSilentlyUpgradedToTLS(t *testing.T) {
	raw := "user:pass@tcp(db:3306)/mindease?parseTime=true"
	if _, err := DSNWithOptions(raw, "true"); err == nil {
		t.Fatal("a raw DSN with a separate TLS mode must be refused rather than ignore the setting")
	}
	same, err := DSNWithOptions(raw, "")
	if err != nil || same != raw {
		t.Fatalf("raw DSN should pass through unchanged, got %q, %v", same, err)
	}
}

func TestOpenWithOptionsRejectsInvalidOptionsBeforeDialing(t *testing.T) {
	o := DefaultOptions()
	o.MaxIdleConns = o.MaxOpenConns + 1
	if _, err := OpenWithOptions("mysql://user:pass@localhost/mindease", o); err == nil {
		t.Fatal("OpenWithOptions must validate before opening a pool")
	}
}
