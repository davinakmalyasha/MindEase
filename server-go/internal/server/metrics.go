package server

import (
	"crypto/subtle"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// serverMetrics owns one registry per process. It is deliberately not the
// prometheus.DefaultRegisterer: tests construct many servers, and a package
// global would either duplicate collectors or leak observations between them.
type serverMetrics struct {
	registry *prometheus.Registry

	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inflight prometheus.Gauge
	jobRuns  *prometheus.CounterVec

	rateLimitFallbacks prometheus.Counter
}

func newServerMetrics(pool *sql.DB) *serverMetrics {
	m := &serverMetrics{
		registry: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "mindease_http_requests_total",
			Help: "HTTP requests by method, chi route pattern and response status.",
		}, []string{"method", "route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "mindease_http_request_duration_seconds",
			Help:    "HTTP request latency by method and chi route pattern.",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 20, 30},
		}, []string{"method", "route"}),
		inflight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "mindease_http_inflight_requests",
			Help: "Requests currently being served (including ones about to time out).",
		}),
		jobRuns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "mindease_jobs_runs_total",
			Help: "Scheduled job runs by name and result.",
		}, []string{"job", "result"}),
		rateLimitFallbacks: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "mindease_rate_limit_fallbacks_total",
			Help: "Rate-limit checks that used the in-process counter because Redis failed.",
		}),
	}

	m.registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.requests, m.duration, m.inflight, m.jobRuns, m.rateLimitFallbacks,
	)
	if pool != nil {
		m.registry.MustRegister(newDBPoolCollector(pool))
	}
	return m
}

func (m *serverMetrics) handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{EnableOpenMetrics: true})
}

// MetricsHandler exposes the scrape endpoint. A token is required whenever one
// is configured; production refuses to start with METRICS_ADDR and no token.
// The handler is served by the private admin listener, never by Mount().
func (s *Server) MetricsHandler(authToken string) http.Handler {
	h := s.metrics.handler()
	if authToken == "" {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		got := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		if subtle.ConstantTimeCompare([]byte(got), []byte(authToken)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (s *Server) metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.metrics == nil {
			next.ServeHTTP(w, r)
			return
		}
		s.metrics.inflight.Inc()
		defer s.metrics.inflight.Dec()

		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		s.metrics.requests.WithLabelValues(r.Method, route, strconv.Itoa(rec.status)).Inc()
		s.metrics.duration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
	})
}

func (s *Server) observeJob(name string, ok bool) {
	if s.metrics == nil {
		return
	}
	result := "ok"
	if !ok {
		result = "error"
	}
	s.metrics.jobRuns.WithLabelValues(name, result).Inc()
}

// dbPoolCollector exposes database/sql's live pool state. The wait values are
// cumulative in database/sql, so they are emitted as counters even though the
// collector reads them on demand.
type dbPoolCollector struct {
	pool *sql.DB

	open, inUse, idle, maxOpen *prometheus.Desc
	waitCount, waitDuration    *prometheus.Desc
}

func newDBPoolCollector(pool *sql.DB) *dbPoolCollector {
	return &dbPoolCollector{
		pool: pool,
		open: prometheus.NewDesc("mindease_db_pool_open_connections",
			"Connections currently open to MySQL.", nil, nil),
		inUse: prometheus.NewDesc("mindease_db_pool_in_use_connections",
			"Connections currently executing a query.", nil, nil),
		idle: prometheus.NewDesc("mindease_db_pool_idle_connections",
			"Idle connections held by the pool.", nil, nil),
		maxOpen: prometheus.NewDesc("mindease_db_pool_max_open_connections",
			"Configured ceiling for this process's pool.", nil, nil),
		waitCount: prometheus.NewDesc("mindease_db_pool_wait_count_total",
			"Cumulative number of waits for a free connection.", nil, nil),
		waitDuration: prometheus.NewDesc("mindease_db_pool_wait_duration_seconds_total",
			"Cumulative time spent waiting for a free connection.", nil, nil),
	}
}

func (c *dbPoolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.open
	ch <- c.inUse
	ch <- c.idle
	ch <- c.maxOpen
	ch <- c.waitCount
	ch <- c.waitDuration
}

func (c *dbPoolCollector) Collect(ch chan<- prometheus.Metric) {
	stats := c.pool.Stats()
	ch <- prometheus.MustNewConstMetric(c.open, prometheus.GaugeValue, float64(stats.OpenConnections))
	ch <- prometheus.MustNewConstMetric(c.inUse, prometheus.GaugeValue, float64(stats.InUse))
	ch <- prometheus.MustNewConstMetric(c.idle, prometheus.GaugeValue, float64(stats.Idle))
	ch <- prometheus.MustNewConstMetric(c.maxOpen, prometheus.GaugeValue, float64(stats.MaxOpenConnections))
	ch <- prometheus.MustNewConstMetric(c.waitCount, prometheus.CounterValue, float64(stats.WaitCount))
	ch <- prometheus.MustNewConstMetric(c.waitDuration, prometheus.CounterValue, stats.WaitDuration.Seconds())
}
