// Package config ports server/src/config/env.ts: the same fail-fast
// production validation, so a deployment cannot boot with a published secret
// or a payment simulator it did not opt into.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

var knownWeak = map[string]bool{
	"supersecret":                           true,
	"superrefreshsecret":                    true,
	"changeme":                              true,
	"secret":                                true,
	"password":                              true,
	"change_me":                             true,
	"change_me_access_secret":               true,
	"change_me_refresh_secret":              true,
	"change_me_two_factor_secret":           true,
	"change_me_jwt_secret":                  true,
	"replace_me":                            true,
	"your_secret_here":                      true,
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
	RedisURL       string

	// AI provider (OpenAI-compatible). Defaults to Command Code's gateway and
	// the DeepSeek V4.1 Flash model; AI_API_KEY enables real calls.
	AIProvider string
	AIBaseURL  string
	AIAPIKey   string
	AIModel    string

	AiRequestTimeoutMs  int
	AiCircuitThreshold  int
	AiCircuitCooldownMs int

	FrontendURL string
	Port        int

	PaymentMode      string // "midtrans" | "simulator"
	PaymentServerKey string
	PaymentClientKey string
	PaymentBaseURL   string

	VideoProvider string // "livekit" | "jitsi"
	LiveKitURL    string
	LiveKitKey    string
	LiveKitSecret string

	CORSOrigins []string

	DatabaseURL string
	UploadDir   string
	JobsSecret  string

	// Connection pool. The defaults match the Go port's original hard-coded
	// values; they are configurable because the safe ceiling is a property of
	// the deployment (replicas x MaxOpen must fit the database's limit).
	DBMaxOpenConns    int
	DBMaxIdleConns    int
	DBConnMaxLifetime time.Duration
	DBConnMaxIdleTime time.Duration
	DatabaseTLS       string
	RequestTimeout    time.Duration
	MetricsAddr       string
	MetricsToken      string
	PprofEnabled      bool
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
	c.RedisURL = os.Getenv("REDIS_URL")
	c.AIProvider = valueOr("AI_PROVIDER", "commandcode")
	c.AIBaseURL = valueOr("AI_BASE_URL", "https://api.commandcode.ai/provider/v1")
	c.AIModel = valueOr("AI_MODEL", "deepseek/deepseek-v4.1-flash")
	c.AIAPIKey = strings.TrimSpace(os.Getenv("AI_API_KEY"))

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

	if c.DBMaxOpenConns, err = boundedInt("DB_MAX_OPEN_CONNS", 20, 1, 10_000); err != nil {
		return nil, err
	}
	if c.DBMaxIdleConns, err = boundedInt("DB_MAX_IDLE_CONNS", 10, 0, 10_000); err != nil {
		return nil, err
	}
	if c.DBMaxIdleConns > c.DBMaxOpenConns {
		return nil, fmt.Errorf("[config] DB_MAX_IDLE_CONNS (%d) cannot exceed DB_MAX_OPEN_CONNS (%d).", c.DBMaxIdleConns, c.DBMaxOpenConns)
	}
	if c.DBConnMaxLifetime, err = durationOr("DB_CONN_MAX_LIFETIME", 30*time.Minute); err != nil {
		return nil, err
	}
	if c.DBConnMaxIdleTime, err = durationOr("DB_CONN_MAX_IDLE_TIME", 5*time.Minute); err != nil {
		return nil, err
	}
	c.DatabaseTLS = strings.ToLower(strings.TrimSpace(os.Getenv("DATABASE_TLS")))
	switch c.DatabaseTLS {
	case "", "true", "false", "skip-verify", "preferred":
	default:
		return nil, fmt.Errorf("[config] DATABASE_TLS=%q is not supported (want true, false, preferred, skip-verify, or empty).", c.DatabaseTLS)
	}
	if c.RequestTimeout, err = durationOr("REQUEST_TIMEOUT", 45*time.Second); err != nil {
		return nil, err
	}
	if c.RequestTimeout < time.Second {
		return nil, fmt.Errorf("[config] REQUEST_TIMEOUT must be at least 1s.")
	}

	c.MetricsAddr = strings.TrimSpace(os.Getenv("METRICS_ADDR"))
	c.MetricsToken = strings.TrimSpace(os.Getenv("METRICS_TOKEN"))
	c.PprofEnabled = strings.EqualFold(strings.TrimSpace(os.Getenv("PPROF_ENABLED")), "true")
	if c.PprofEnabled && c.MetricsAddr == "" {
		return nil, fmt.Errorf("[config] PPROF_ENABLED=true requires METRICS_ADDR; pprof is never served on the public API listener.")
	}
	if isProd && c.MetricsAddr != "" && c.MetricsToken == "" {
		return nil, fmt.Errorf("[config] METRICS_ADDR is set in production without METRICS_TOKEN. Refusing to expose metrics and pprof unauthenticated.")
	}
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

func boundedInt(name string, fallback, min, max int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("[config] %s=%q must be an integer between %d and %d.", name, raw, min, max)
	}
	return n, nil
}

func durationOr(name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("[config] %s=%q must be a positive duration such as 30m or 45s.", name, raw)
	}
	return d, nil
}

func valueOr(name, fallback string) string {
	if v := os.Getenv(name); strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}
