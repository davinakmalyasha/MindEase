// Package server is the Go port of the MindEase API: the same HTTP surface,
// the same database and Redis, the same response contracts.
package server

import (
	"database/sql"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
	"github.com/redis/go-redis/v9"

	"github.com/davinakmalyasha/MindEase/server-go/internal/ai"
	"github.com/davinakmalyasha/MindEase/server-go/internal/config"
)

type Server struct {
	Cfg       *config.Config
	DB        *sql.DB
	Redis     *redis.Client
	Log       *slog.Logger
	Sanitizer *bluemonday.Policy

	// AI is nil when no key is configured; every AI surface then serves its
	// deterministic fallback with source "fallback".
	AI        *ai.Client
	aiBreaker *aiBreaker
}

func New(cfg *config.Config, pool *sql.DB, rdb *redis.Client, log *slog.Logger) *Server {
	policy := bluemonday.UGCPolicy()
	s := &Server{Cfg: cfg, DB: pool, Redis: rdb, Log: log, Sanitizer: policy}
	if cfg.AIAPIKey != "" && cfg.AIBaseURL != "" && cfg.AIModel != "" {
		s.AI = ai.New(cfg.AIBaseURL, cfg.AIAPIKey, cfg.AIModel,
			time.Duration(cfg.AiRequestTimeoutMs)*time.Millisecond)
	}
	s.aiBreaker = newAIBreaker(cfg.AiCircuitThreshold, time.Duration(cfg.AiCircuitCooldownMs)*time.Millisecond)
	return s
}

func (s *Server) Mount() http.Handler {
	r := chi.NewRouter()
	r.Use(s.requestID, s.securityHeaders, s.cors, s.bodyLimit, s.accessLog, s.recoverer)

	r.Handle("/uploads/*", s.uploadsHandler())

	api := chi.NewRouter()
	api.Use(s.generalLimiter(), s.csrfMiddleware)

	api.Get("/health", s.healthHandler)
	api.Get("/health/db", s.healthDBHandler)
	api.Get("/csrf-token", s.csrfTokenHandler)
	api.Get("/openapi.json", s.openAPIHandler)

	s.registerInternal(api)
	s.registerAuth(api)
	s.registerAccount(api)
	s.registerUser(api)
	s.registerDoctors(api)
	s.registerAppointments(api)
	s.registerFollowUps(api)
	s.registerAdmin(api)
	s.registerReviews(api)
	s.registerNotifications(api)
	s.registerAI(api)
	s.registerWellness(api)
	s.registerMessages(api)
	s.registerSupport(api)
	s.registerPush(api)
	s.registerRealtime(api)
	s.registerPayments(api)
	s.registerCare(api)

	r.Mount("/api", api)

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		s.Fail(w, http.StatusNotFound, "Route not found")
	})
	return r
}

func (s *Server) healthHandler(w http.ResponseWriter, _ *http.Request) {
	s.JSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"uptime":    uptimeSeconds(),
		"timestamp": nowISO(),
	})
}

// expectedTables is the schema contract the health check verifies, matching
// Prisma's 28 models. Compared case-insensitively because MySQL's
// lower_case_table_names differs between platforms.
var expectedTables = []string{
	"User", "Doctor", "Appointment", "Review", "ReviewReport", "Message",
	"Notification", "ConsultationSlot", "AvailabilityPattern", "PreSessionData",
	"RiskAlert", "RefreshToken", "MoodEntry", "JournalEntry", "Assessment",
	"CarePlan", "CareGoal", "CareStep", "SafetyPlan", "AuditLog", "JobLock",
	"FollowUp", "WaitlistEntry", "Package", "PackagePurchase", "PaymentOrder",
	"PushSubscription", "Referral",
}

func (s *Server) healthDBHandler(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()")
	if err != nil {
		s.Log.Error("db health check failed", "err", err)
		s.JSON(w, http.StatusServiceUnavailable, map[string]any{"status": "error", "db": "unreachable"})
		return
	}
	defer rows.Close()
	present := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			s.Log.Error("db health scan failed", "err", err)
			s.JSON(w, http.StatusServiceUnavailable, map[string]any{"status": "error", "db": "unreachable"})
			return
		}
		present[strings.ToLower(name)] = true
	}
	var missing []string
	for _, table := range expectedTables {
		if !present[strings.ToLower(table)] {
			missing = append(missing, table)
		}
	}
	if len(missing) > 0 {
		s.Log.Error("db health check: schema is behind", "missingCount", len(missing), "missing", missing)
		s.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "error", "db": "reachable", "schema": "drift", "missingCount": len(missing),
		})
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "ok", "db": "connected", "schema": "ok", "tables": len(expectedTables),
	})
}

var imageName = regexp.MustCompile(`(?i)\.(png|jpe?g|webp|gif)$`)

func (s *Server) uploadsHandler() http.Handler {
	fs := http.StripPrefix("/uploads/", http.FileServer(http.Dir(s.Cfg.UploadDir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !imageName.MatchString(r.URL.Path) {
			w.Header().Set("Content-Disposition", "attachment")
		}
		fs.ServeHTTP(w, r)
	})
}

// openAPIHandler serves a minimal, machine-readable document. The full spec is
// generated by the Node reference during the transition; this keeps client
// generators pointed at a live endpoint.
func (s *Server) openAPIHandler(w http.ResponseWriter, _ *http.Request) {
	s.JSON(w, http.StatusOK, map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":       "MindEase API",
			"version":     "0.3.0",
			"description": "Go port in progress; the Node reference remains the source of request schemas during the transition.",
		},
		"paths": map[string]any{},
	})
}
