// Package config ports server/src/config/env.ts: the same fail-fast
// production validation, so a deployment cannot boot with a published secret
// or a payment simulator it did not opt into.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

var knownWeak = map[string]bool{
	"supersecret":                          true,
	"superrefreshsecret":                   true,
	"changeme":                             true,
	"secret":                               true,
	"password":                             true,
	"change_me":                            true,
	"change_me_access_secret":              true,
	"change_me_refresh_secret":             true,
	"change_me_two_factor_secret":          true,
	"change_me_jwt_secret":                 true,
	"replace_me":                           true,
	"your_secret_here":                     true,
	"local_dev_two_factor_secret_change_me": true,
}

// Config is the parsed environment. Every field is validated at load.
type Config struct {
	IsProd bool
	IsTest bool

	JWTSecret       string
	RefreshSecret   string
	TwoFactorSecret string

	GoogleClientID string
	GeminiAPIKey   string
	RedisURL       string

	AiRequestTimeoutMs int
	AiCircuitThreshold int
	AiCircuitCooldownMs int

	FrontendURL string
	Port        int

	PaymentMode       string // "midtrans" | "simulator"
	PaymentServerKey  string
	PaymentClientKey  string
	PaymentBaseURL    string

	VideoProvider string // "livekit" | "jitsi"
	LiveKitURL    string
	LiveKitKey    string
	LiveKitSecret string

	CORSOrigins []string

	DatabaseURL string
	UploadDir   string
	JobsSecret  string
}

func Load() (*Config, error) {
	isProd := os.Getenv("NODE_ENV") == "production"
	c := &Config{IsProd: isProd, IsTest: os.Getenv("NODE_ENV") == "test"}

	var err error
	if c.JWTSecret, err = requireSecret("JWT_SECRET", "dev_only_insecure_jwt_secret_change_me", isProd); err != nil {
		return nil, err
	}
	if c.RefreshSecret, err = requireSecret("REFRESH_SECRET", "dev_only_insecure_refresh_secret_change_me", isProd); err != nil {
		return nil, err
	}
	if isProd && c.RefreshSecret == c.JWTSecret {
		return nil, fmt.Errorf("[config] REFRESH_SECRET must differ from JWT_SECRET in production.")
	}
	// Dev fallback is the jwt secret so an unset value behaves as it did.
	if c.TwoFactorSecret, err = requireSecret("TWO_FACTOR_SECRET", c.JWTSecret, isProd); err != nil {
		return nil, err
	}
	if isProd && c.TwoFactorSecret == c.JWTSecret {
		return nil, fmt.Errorf("[config] TWO_FACTOR_SECRET must differ from JWT_SECRET in production.")
	}

	c.GoogleClientID = os.Getenv("GOOGLE_CLIENT_ID")
	c.GeminiAPIKey = os.Getenv("GEMINI_API_KEY")
	c.RedisURL = os.Getenv("REDIS_URL")

	c.AiRequestTimeoutMs = positiveInt("AI_REQUEST_TIMEOUT_MS", 20_000)
	c.AiCircuitThreshold = positiveInt("AI_CIRCUIT_THRESHOLD", 5)
	c.AiCircuitCooldownMs = positiveInt("AI_CIRCUIT_COOLDOWN_MS", 60_000)

	c.FrontendURL = valueOr("FRONTEND_URL", "http://localhost:3000")
	c.Port = positiveInt("PORT", 5000)

	if c.PaymentMode, c.PaymentServerKey, c.PaymentClientKey, c.PaymentBaseURL, err = payments(isProd); err != nil {
		return nil, err
	}
	if c.VideoProvider, err = videoProvider(); err != nil {
		return nil, err
	}
	c.LiveKitURL = strings.TrimSpace(os.Getenv("LIVEKIT_URL"))
	c.LiveKitKey = strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY"))
	c.LiveKitSecret = strings.TrimSpace(os.Getenv("LIVEKIT_API_SECRET"))

	c.CORSOrigins = corsOrigins()

	c.DatabaseURL = valueOr("DATABASE_URL", "mysql://mindease:mindease@localhost:3306/mindease")
	c.UploadDir = valueOr("UPLOAD_DIR", "public/uploads")
	c.JobsSecret = strings.TrimSpace(os.Getenv("JOBS_SECRET"))
	return c, nil
}

func requireSecret(name, devFallback string, isProd bool) (string, error) {
	value := os.Getenv(name)
	if strings.TrimSpace(value) == "" {
		if isProd {
			return "", fmt.Errorf("[config] Missing required environment variable: %s. Refusing to start in production.", name)
		}
		return devFallback, nil
	}
	if isProd && knownWeak[strings.ToLower(value)] {
		return "", fmt.Errorf("[config] %s is set to a known weak default value. Refusing to start in production.", name)
	}
	if isProd && strings.HasPrefix(value, "dev_") {
		return "", fmt.Errorf("[config] %s still uses its development fallback. Refusing to start in production.", name)
	}
	if isProd && len(value) < 16 {
		return "", fmt.Errorf("[config] %s must be at least 16 characters long. Refusing to start in production.", name)
	}
	return value, nil
}

func payments(isProd bool) (mode, serverKey, clientKey, baseURL string, err error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("PAYMENT_PROVIDER")))
	serverKey = strings.TrimSpace(os.Getenv("PAYMENT_SERVER_KEY"))
	clientKey = strings.TrimSpace(os.Getenv("PAYMENT_CLIENT_KEY"))
	baseURL = strings.TrimSpace(os.Getenv("PAYMENT_BASE_URL"))
	allowSimulator := strings.TrimSpace(os.Getenv("ALLOW_PAYMENT_SIMULATOR")) == "true"

	known := map[string]bool{"midtrans": true, "simulator": true}
	if provider != "" && !known[provider] {
		return "", "", "", "", fmt.Errorf("[config] PAYMENT_PROVIDER=%s is not a known provider (expected one of: midtrans, simulator).", provider)
	}
	if provider == "" || serverKey == "" {
		if isProd && !allowSimulator {
			return "", "", "", "", fmt.Errorf("[config] PAYMENT_PROVIDER and PAYMENT_SERVER_KEY are required in production. Refusing to start with the payment simulator enabled. Set real credentials, or set ALLOW_PAYMENT_SIMULATOR=true if this is a local/demo deployment that must not take real payments.")
		}
		return "simulator", "", "", "", nil
	}
	if isProd && provider == "simulator" && !allowSimulator {
		return "", "", "", "", fmt.Errorf("[config] PAYMENT_PROVIDER=simulator is not permitted in production (set ALLOW_PAYMENT_SIMULATOR=true to override for a local demo).")
	}
	if baseURL == "" && provider == "midtrans" {
		baseURL = "https://app.midtrans.com"
	}
	return provider, serverKey, clientKey, baseURL, nil
}

func videoProvider() (string, error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("VIDEO_PROVIDER")))
	if provider != "" && provider != "livekit" && provider != "jitsi" {
		return "", fmt.Errorf("[config] VIDEO_PROVIDER=%s is not a known provider (expected one of: livekit, jitsi).", provider)
	}
	if provider == "" {
		return "jitsi", nil
	}
	return provider, nil
}

func corsOrigins() []string {
	var origins []string
	for _, o := range strings.Split(os.Getenv("CORS_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins = append(origins, o)
		}
	}
	if frontend := strings.TrimSpace(os.Getenv("FRONTEND_URL")); frontend != "" {
		origins = append(origins, frontend)
	}
	if len(origins) == 0 {
		return []string{"http://localhost:3000"}
	}
	seen := map[string]bool{}
	out := origins[:0]
	for _, o := range origins {
		if !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

func positiveInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func valueOr(name, fallback string) string {
	if v := os.Getenv(name); strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}
