package config

import "testing"

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
	for _, name := range []string{"JWT_SECRET", "REFRESH_SECRET", "TWO_FACTOR_SECRET", "PAYMENT_PROVIDER", "PAYMENT_SERVER_KEY", "VIDEO_PROVIDER"} {
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

func TestProductionRequiresDistinctSigningSecrets(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("JWT_SECRET", "9d2f6a1c4b7e8f0a1b3c5d7e")
	t.Setenv("REFRESH_SECRET", "9d2f6a1c4b7e8f0a1b3c5d7e")
	t.Setenv("TWO_FACTOR_SECRET", "9d2f6a1c4b7e8f0a1b3c5d7e")
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
