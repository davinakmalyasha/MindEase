package config

import (
	"strings"
	"testing"
	"time"
)

func TestRequireSecretRejectsWeakAndDevFallbacksInProduction(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{"empty uses dev fallback", ""},
		{"known weak", "change_me"},
		{"template placeholder", "change_me_access_secret"},
		{"dev prefix", "dev_only_insecure_jwt_secret_change_me"},
		{"too short", "short"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NODE_ENV", "production")
			t.Setenv("JWT_SECRET", tc.value)
			if _, err := Load(); err == nil {
				t.Fatalf("expected Load to refuse %q in production", tc.value)
			}
		})
	}
}

func TestLoadAllowsDevFallbacksOutsideProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	for _, name := range []string{
		"JWT_SECRET", "REFRESH_SECRET", "TWO_FACTOR_SECRET", "PAYMENT_PROVIDER",
		"PAYMENT_SERVER_KEY", "VIDEO_PROVIDER", "DB_MAX_OPEN_CONNS", "DB_MAX_IDLE_CONNS",
		"DB_CONN_MAX_LIFETIME", "DB_CONN_MAX_IDLE_TIME", "DATABASE_TLS",
		"REQUEST_TIMEOUT", "METRICS_ADDR", "METRICS_TOKEN", "PPROF_ENABLED",
	} {
		t.Setenv(name, "")
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("development load should not fail: %v", err)
	}
	if cfg.IsProd {
		t.Fatal("IsProd should be false")
	}
	if cfg.PaymentMode != "simulator" {
		t.Fatalf("expected the simulator without credentials, got %q", cfg.PaymentMode)
	}
	if cfg.VideoProvider != "jitsi" {
		t.Fatalf("expected the jitsi fallback without configuration, got %q", cfg.VideoProvider)
	}
}

func setProductionSigningSecrets(t *testing.T) {
	t.Setenv("JWT_SECRET", strings.Repeat("a", 32))
	t.Setenv("REFRESH_SECRET", strings.Repeat("b", 32))
	t.Setenv("TWO_FACTOR_SECRET", strings.Repeat("c", 32))
}

func TestProductionRequiresDistinctSigningSecrets(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	secret := strings.Repeat("s", 32)
	t.Setenv("JWT_SECRET", secret)
	t.Setenv("REFRESH_SECRET", secret)
	t.Setenv("TWO_FACTOR_SECRET", secret)
	if _, err := Load(); err == nil {
		t.Fatal("expected identical signing secrets to be refused in production")
	}
}

func TestPaymentProviderMustBeKnown(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	t.Setenv("PAYMENT_PROVIDER", "midtranss")
	t.Setenv("PAYMENT_SERVER_KEY", "x")
	if _, err := Load(); err == nil {
		t.Fatal("a typo'd provider must not boot")
	}
}

func TestPoolTimeoutAndTLSDefaults(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	for _, name := range []string{
		"DB_MAX_OPEN_CONNS", "DB_MAX_IDLE_CONNS", "DB_CONN_MAX_LIFETIME",
		"DB_CONN_MAX_IDLE_TIME", "DATABASE_TLS", "REQUEST_TIMEOUT",
		"METRICS_ADDR", "METRICS_TOKEN", "PPROF_ENABLED",
	} {
		t.Setenv(name, "")
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DBMaxOpenConns != 20 || cfg.DBMaxIdleConns != 10 {
		t.Fatalf("unexpected pool defaults: %+v", cfg)
	}
	if cfg.RequestTimeout != 45*time.Second {
		t.Fatalf("unexpected request timeout: %v", cfg.RequestTimeout)
	}
	if cfg.MetricsAddr != "" || cfg.PprofEnabled {
		t.Fatalf("observability should be off by default: %+v", cfg)
	}
	if cfg.DatabaseTLS != "" {
		t.Fatalf("TLS should be off by default, got %q", cfg.DatabaseTLS)
	}
}

func TestPoolConfigurationIsRejectedWhenUnsafeOrMalformed(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	t.Setenv("DB_MAX_OPEN_CONNS", "5")
	t.Setenv("DB_MAX_IDLE_CONNS", "10")
	if _, err := Load(); err == nil {
		t.Fatal("idle connections above the open ceiling must not boot")
	}

	t.Setenv("DB_MAX_OPEN_CONNS", "not-a-number")
	t.Setenv("DB_MAX_IDLE_CONNS", "")
	if _, err := Load(); err == nil {
		t.Fatal("a malformed pool size must not silently fall back")
	}

	t.Setenv("DB_MAX_OPEN_CONNS", "")
	t.Setenv("DB_CONN_MAX_LIFETIME", "30")
	if _, err := Load(); err == nil {
		t.Fatal("a duration without a unit must not boot")
	}

	t.Setenv("DB_CONN_MAX_LIFETIME", "")
	t.Setenv("REQUEST_TIMEOUT", "250ms")
	if _, err := Load(); err == nil {
		t.Fatal("a sub-second request timeout must not boot")
	}
}

func TestDatabaseTLSRejectsUnknownModes(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	t.Setenv("DATABASE_TLS", "require")
	if _, err := Load(); err == nil {
		t.Fatal("an unknown TLS mode must not boot")
	}
}

func TestProductionMetricsNeedAToken(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	setProductionSigningSecrets(t)
	t.Setenv("PAYMENT_PROVIDER", "")
	t.Setenv("PAYMENT_SERVER_KEY", "")
	t.Setenv("ALLOW_PAYMENT_SIMULATOR", "true")
	t.Setenv("METRICS_ADDR", "127.0.0.1:9090")
	t.Setenv("METRICS_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("production must refuse to expose metrics without a token")
	}
}

func TestPprofRequiresThePrivateListener(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	t.Setenv("PPROF_ENABLED", "true")
	t.Setenv("METRICS_ADDR", "")
	if _, err := Load(); err == nil {
		t.Fatal("pprof must not be enabled without the admin listener")
	}
}
