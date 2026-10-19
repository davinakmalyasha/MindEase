package server

// Integration tests: the HTTP surface against a real MySQL database.
//
// They run only when TEST_DATABASE_URL is set (CI's api-go job provides a MySQL
// service; locally, point it at a scratch database). TestMain creates the
// database if needed, drops every table and applies the embedded migrations;
// each test wipes the data tables so the invariants are checked on a known
// state. These tests exist because the browser suite covers the flows while the
// Go unit tests cover pure functions - the races and constraints between them
// had no home after the Node suite was retired.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davinakmalyasha/MindEase/server-go/internal/config"
	"github.com/davinakmalyasha/MindEase/server-go/internal/db"
	"github.com/davinakmalyasha/MindEase/server-go/internal/migrate"
	"github.com/davinakmalyasha/MindEase/server-go/migrations"
)

var (
	itPool     *sql.DB
	itEnabled  bool
	itLocation = mustLoadLocation("Asia/Jakarta")
	itLog      = slog.New(slog.NewTextHandler(io.Discard, nil))
)

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}

func TestMain(m *testing.M) {
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		os.Exit(m.Run()) // each test skips; pure unit tests still run
	}
	itEnabled = true
	ctx := context.Background()
	if err := ensureTestDatabase(ctx, raw); err != nil {
		fmt.Fprintln(os.Stderr, "integration tests: cannot create the test database:", err)
		os.Exit(1)
	}
	pool, err := db.Open(raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "integration tests: cannot open the test database:", err)
		os.Exit(1)
	}
	itPool = pool
	if err := dropAllTables(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "integration tests: cannot reset the schema:", err)
		os.Exit(1)
	}
	if err := migrate.Run(ctx, raw, migrations.FS, itLog); err != nil {
		fmt.Fprintln(os.Stderr, "integration tests: migrations failed:", err)
		os.Exit(1)
	}
	code := m.Run()
	pool.Close()
	os.Exit(code)
}

func ensureTestDatabase(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return errors.New("TEST_DATABASE_URL has no database name")
	}
	pass, _ := u.User.Password()
	host := u.Host
	if !strings.Contains(host, ":") {
		host += ":3306"
	}
	serverDSN := fmt.Sprintf("%s:%s@tcp(%s)/?parseTime=true&charset=utf8mb4",
		u.User.Username(), pass, host)
	server, err := sql.Open("mysql", serverDSN)
	if err != nil {
		return err
	}
	defer server.Close()
	_, err = server.ExecContext(ctx,
		"CREATE DATABASE IF NOT EXISTS `"+name+"` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	return err
}

// dropAllTables removes the application tables and the migration bookkeeping, so
// TestMain always starts from zero. Foreign keys are disabled on a single
// connection for the duration; the setting is session-scoped.
func dropAllTables(ctx context.Context) error {
	conn, err := itPool.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "SET FOREIGN_KEY_CHECKS=0"); err != nil {
		return err
	}
	rows, err := conn.QueryContext(ctx,
		"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'")
	if err != nil {
		return err
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		names = append(names, name)
	}
	rows.Close()
	for _, name := range names {
		if _, err := conn.ExecContext(ctx, "DROP TABLE IF EXISTS `"+name+"`"); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "SET FOREIGN_KEY_CHECKS=1")
	return err
}

func wipe(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	conn, err := itPool.Conn(ctx)
	if err != nil {
		t.Fatalf("wipe: %v", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "SET FOREIGN_KEY_CHECKS=0"); err != nil {
		t.Fatalf("wipe: %v", err)
	}
	for _, table := range expectedTables {
		if _, err := conn.ExecContext(ctx, "DELETE FROM `"+table+"`"); err != nil {
			t.Fatalf("wipe %s: %v", table, err)
		}
	}
	if _, err := conn.ExecContext(ctx, "SET FOREIGN_KEY_CHECKS=1"); err != nil {
		t.Fatalf("wipe: %v", err)
	}
}

func testConfig(t *testing.T) *config.Config {
	t.Helper()
	return &config.Config{
		IsTest:          true,
		JWTSecret:       "integration-jwt-secret-0123456789",
		RefreshSecret:   "integration-refresh-secret-0123456789",
		TwoFactorSecret: "integration-2fa-secret-0123456789",
		PaymentMode:     "simulator",
		VideoProvider:   "jitsi",
		FrontendURL:     "http://localhost:3000",
		CORSOrigins:     []string{"http://localhost:3000"},
		UploadDir:       t.TempDir(),
		JobsSecret:      "integration-jobs-secret",
	}
}

func newIntegrationServer(t *testing.T) *Server {
	t.Helper()
	if !itEnabled {
		t.Skip("TEST_DATABASE_URL is not set; integration tests skipped")
	}
	wipe(t)
	return New(testConfig(t), itPool, nil, itLog)
}

type testClient struct {
	t       *testing.T
	h       http.Handler
	csrf    string
	cookies map[string]*http.Cookie
}

func newTestClient(t *testing.T, h http.Handler) *testClient {
	return &testClient{t: t, h: h, cookies: map[string]*http.Cookie{}}
}

func (c *testClient) clone() *testClient {
	out := &testClient{t: c.t, h: c.h, csrf: c.csrf, cookies: map[string]*http.Cookie{}}
	for k, v := range c.cookies {
		out.cookies[k] = v
	}
	return out
}

// request performs one request. Extra headers are optional and used for the
// internal job trigger, whose auth is a shared secret rather than a cookie.
func (c *testClient) request(method, path string, body any, headers ...map[string]string) (*httptest.ResponseRecorder, map[string]any, string) {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, cookie := range c.cookies {
		req.AddCookie(cookie)
	}
	if method != http.MethodGet && method != http.MethodHead && c.csrf != "" {
		req.Header.Set("X-CSRF-Token", c.csrf)
	}
	for _, set := range headers {
		for k, v := range set {
			req.Header.Set(k, v)
		}
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	for _, cookie := range rec.Result().Cookies() {
		if cookie.MaxAge < 0 {
			delete(c.cookies, cookie.Name)
			continue
		}
		c.cookies[cookie.Name] = cookie
	}
	text := rec.Body.String()
	var parsed map[string]any
	if text != "" {
		_ = json.Unmarshal([]byte(text), &parsed)
	}
	return rec, parsed, text
}

func (c *testClient) ensureCSRF() {
	c.t.Helper()
	rec, parsed, text := c.request(http.MethodGet, "/api/csrf-token", nil)
	if rec.Code != http.StatusOK {
		c.t.Fatalf("csrf bootstrap: %d %s", rec.Code, text)
	}
	if data, ok := parsed["data"].(map[string]any); ok {
		c.csrf, _ = data["csrfToken"].(string)
	}
	if c.csrf == "" {
		c.t.Fatal("csrf bootstrap returned no token")
	}
}

func (c *testClient) login(email, password string) {
	c.t.Helper()
	c.ensureCSRF()
	rec, _, text := c.request(http.MethodPost, "/api/auth/login", map[string]any{
		"email": email, "password": password,
	})
	if rec.Code != http.StatusOK {
		c.t.Fatalf("login %s: %d %s", email, rec.Code, text)
	}
}

func uniqueEmail(t *testing.T) string {
	t.Helper()
	replacer := regexp.MustCompile(`[^a-z0-9-]+`)
	base := replacer.ReplaceAllString(strings.ToLower(t.Name()), "-")
	return fmt.Sprintf("%s-%d@example.test", base, time.Now().UnixNano())
}

func seedUser(t *testing.T, email, password, role string) string {
	t.Helper()
	hashed, err := hashPassword(password)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	id := newID()
	now := time.Now().UTC()
	_, err = itPool.ExecContext(context.Background(),
		"INSERT INTO `User` (id, email, password, name, role, isVerified, provider, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?)",
		id, email, hashed, "Test "+role, role, true, "local", now, now)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return id
}

func seedDoctor(t *testing.T, email, name string) (userID, doctorID string) {
	t.Helper()
	userID = seedUser(t, email, "Doctor@123", "doctor")
	doctorID = newID()
	now := time.Now().UTC()
	_, err := itPool.ExecContext(context.Background(),
		"INSERT INTO `Doctor` (id, userId, specialty, bio, experience, price, availability, verificationStatus, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?)",
		doctorID, userID, "Clinical Psychologist", "Integration test clinician.", 5, 200000, "Available", "approved", now, now)
	if err != nil {
		t.Fatalf("seed doctor: %v", err)
	}
	return userID, doctorID
}

// seedSlot anchors the day at UTC midnight of the WIB calendar day - the same
// anchor the seed uses, so the payload day key agrees with the API's WIB day.
func seedSlot(t *testing.T, doctorID string, days int, start, end string) (slotID, dayKey string) {
	t.Helper()
	today := time.Now().In(itLocation)
	date := time.Date(today.Year(), today.Month(), today.Day()+days, 0, 0, 0, 0, time.UTC)
	slotID = newID()
	_, err := itPool.ExecContext(context.Background(),
		"INSERT INTO `ConsultationSlot` (id, doctorId, date, startTime, endTime, isBooked) VALUES (?,?,?,?,?,?)",
		slotID, doctorID, date, start, end, false)
	if err != nil {
		t.Fatalf("seed slot: %v", err)
	}
	return slotID, date.In(itLocation).Format("2006-01-02")
}

func seedPackage(t *testing.T, doctorID string, sessions, price int) string {
	t.Helper()
	id := newID()
	_, err := itPool.ExecContext(context.Background(),
		"INSERT INTO `Package` (id, doctorId, name, description, sessionCount, totalPrice, active, createdAt) "+
			"VALUES (?,?,?,?,?,?,?,?)",
		id, doctorID, "Three-session package", "Integration test package.", sessions, price, true, time.Now().UTC())
	if err != nil {
		t.Fatalf("seed package: %v", err)
	}
	return id
}

func seedCompletedAppointment(t *testing.T, userID, doctorID string) string {
	t.Helper()
	id := newID()
	date := time.Now().UTC().Add(-24 * time.Hour)
	_, err := itPool.ExecContext(context.Background(),
		"INSERT INTO `Appointment` (id, userId, doctorId, appointmentDate, startTime, endTime, consultationType, status, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?)",
		id, userID, doctorID, date, "09:00", "10:00", "video", "completed", date, date)
	if err != nil {
		t.Fatalf("seed appointment: %v", err)
	}
	return id
}

func dataObject(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("response has no data object: %#v", body)
	}
	return data
}

func TestIntegrationAuthRefreshRotation(t *testing.T) {
	s := newIntegrationServer(t)
	c := newTestClient(t, s.Mount())
	email := uniqueEmail(t)
	c.ensureCSRF()

	rec, body, text := c.request(http.MethodPost, "/api/auth/register", map[string]any{
		"email": email, "password": "Patient@123", "name": "Refresh Test", "role": "patient",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, text)
	}
	userID := dataObject(t, body)["user"].(map[string]any)["id"].(string)
	oldRefresh := c.cookies["refreshToken"].Value

	rec, _, text = c.request(http.MethodPost, "/api/auth/refresh", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, text)
	}
	newRefresh := c.cookies["refreshToken"].Value
	if newRefresh == oldRefresh {
		t.Fatal("refresh did not rotate the token")
	}

	// Replaying the rotated token is treated as theft: 403, and every session
	// for the account is revoked.
	c.cookies["refreshToken"] = &http.Cookie{Name: "refreshToken", Value: oldRefresh}
	rec, _, _ = c.request(http.MethodPost, "/api/auth/refresh", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("replayed refresh: %d, want 403", rec.Code)
	}
	var stored int
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `RefreshToken` WHERE userId = ?", userID).Scan(&stored); err != nil {
		t.Fatalf("count refresh tokens: %v", err)
	}
	if stored != 0 {
		t.Fatalf("reuse detection left %d refresh tokens; want 0", stored)
	}

	c.cookies["refreshToken"] = &http.Cookie{Name: "refreshToken", Value: newRefresh}
	rec, _, _ = c.request(http.MethodPost, "/api/auth/refresh", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("rotated token after reuse detection: %d, want 403", rec.Code)
	}
}

func TestIntegrationLoginLockout(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	seedUser(t, email, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.ensureCSRF()

	for i := 0; i < 5; i++ {
		rec, _, _ := c.request(http.MethodPost, "/api/auth/login", map[string]any{
			"email": email, "password": "Wrong@123",
		})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("wrong password %d: %d, want 401", i+1, rec.Code)
		}
	}
	rec, _, text := c.request(http.MethodPost, "/api/auth/login", map[string]any{
		"email": email, "password": "Patient@123",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("correct password while locked: %d %s, want 400", rec.Code, text)
	}
	var failed int
	var lockedUntil *time.Time
	if err := itPool.QueryRow(
		"SELECT failedAttempts, lockedUntil FROM `User` WHERE email = ?", email).
		Scan(&failed, &lockedUntil); err != nil {
		t.Fatalf("read lock state: %v", err)
	}
	if failed != 5 || lockedUntil == nil {
		t.Fatalf("lock state = attempts %d, lockedUntil %v; want 5 and a deadline", failed, lockedUntil)
	}
}

func TestIntegrationBookingClaimIsAtomicAndIdempotent(t *testing.T) {
	s := newIntegrationServer(t)
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Booking")
	slotID, dayKey := seedSlot(t, doctorID, 3, "09:00", "10:00")
	email := uniqueEmail(t)
	seedUser(t, email, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.login(email, "Patient@123")

	base := map[string]any{
		"doctorId":         doctorID,
		"appointmentDate":  dayKey,
		"startTime":        "09:00",
		"endTime":          "10:00",
		"consultationType": "video",
		"slotId":           slotID,
	}
	run := func(key string) int {
		cc := c.clone()
		payload := map[string]any{}
		for k, v := range base {
			payload[k] = v
		}
		payload["idempotencyKey"] = key
		rec, _, _ := cc.request(http.MethodPost, "/api/appointments/book", payload)
		return rec.Code
	}

	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			statuses <- run(fmt.Sprintf("it-booking-%d-%d", i, time.Now().UnixNano()))
		}(i)
	}
	wg.Wait()
	close(statuses)

	var created, rejected int
	for code := range statuses {
		switch code {
		case http.StatusCreated:
			created++
		case http.StatusBadRequest, http.StatusConflict:
			rejected++
		default:
			t.Fatalf("concurrent booking returned %d; want 201 and 400/409", code)
		}
	}
	if created != 1 || rejected != 1 {
		t.Fatalf("concurrent booking: %d created, %d rejected; want exactly one of each", created, rejected)
	}

	var appointments int
	var booked bool
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `Appointment` WHERE slotId = ?", slotID).
		Scan(&appointments); err != nil {
		t.Fatalf("count appointments: %v", err)
	}
	if err := itPool.QueryRow("SELECT isBooked FROM `ConsultationSlot` WHERE id = ?", slotID).
		Scan(&booked); err != nil {
		t.Fatalf("read slot: %v", err)
	}
	if appointments != 1 || !booked {
		t.Fatalf("after claim: %d appointments, booked=%v; want 1 and true", appointments, booked)
	}

	// Idempotent replay: the same key returns the stored row and creates no
	// second appointment.
	var storedID, storedKey string
	if err := itPool.QueryRow("SELECT id, idempotencyKey FROM `Appointment` WHERE slotId = ?", slotID).
		Scan(&storedID, &storedKey); err != nil {
		t.Fatalf("read appointment: %v", err)
	}
	replay := map[string]any{}
	for k, v := range base {
		replay[k] = v
	}
	replay["idempotencyKey"] = storedKey
	rec, body, text := c.request(http.MethodPost, "/api/appointments/book", replay)
	if rec.Code != http.StatusCreated {
		t.Fatalf("idempotent replay: %d %s", rec.Code, text)
	}
	if got := dataObject(t, body)["id"].(string); got != storedID {
		t.Fatalf("replay returned appointment %s; want %s", got, storedID)
	}
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `Appointment`").Scan(&appointments); err != nil {
		t.Fatalf("count after replay: %v", err)
	}
	if appointments != 1 {
		t.Fatalf("idempotent replay created a second appointment (%d)", appointments)
	}
}

func TestIntegrationPaymentLiveCheckoutClaim(t *testing.T) {
	s := newIntegrationServer(t)
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Payment")
	packageID := seedPackage(t, doctorID, 3, 300000)
	patientEmail := uniqueEmail(t)
	userID := seedUser(t, patientEmail, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.login(patientEmail, "Patient@123")

	checkout := func() int {
		cc := c.clone()
		rec, _, _ := cc.request(http.MethodPost, "/api/payments/packages/"+packageID+"/checkout", nil)
		return rec.Code
	}

	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			statuses <- checkout()
		}()
	}
	wg.Wait()
	close(statuses)

	var created, conflict int
	for code := range statuses {
		switch code {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflict++
		default:
			t.Fatalf("concurrent checkout returned %d; want 201 and 409", code)
		}
	}
	if created != 1 || conflict != 1 {
		t.Fatalf("concurrent checkout: %d created, %d conflicts; want one of each", created, conflict)
	}

	var orderID string
	var amount int
	if err := itPool.QueryRow(`
		SELECT o.orderId, o.amount FROM `+"`PaymentOrder`"+` o
		JOIN `+"`PackagePurchase`"+` p ON p.id = o.purchaseId
		WHERE p.userId = ? AND p.packageId = ?`, userID, packageID).
		Scan(&orderID, &amount); err != nil {
		t.Fatalf("read payment order: %v", err)
	}

	rec, _, text := c.request(http.MethodPost, "/api/payments/notification", map[string]any{
		"orderId": orderID, "amount": amount, "outcome": "paid",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("simulated notification: %d %s", rec.Code, text)
	}
	var status string
	var sessionsLeft int
	var liveKey *string
	if err := itPool.QueryRow(
		"SELECT `status`, sessionsLeft, liveKey FROM `PackagePurchase` WHERE userId = ? AND packageId = ?",
		userID, packageID).Scan(&status, &sessionsLeft, &liveKey); err != nil {
		t.Fatalf("read purchase: %v", err)
	}
	if status != "active" || sessionsLeft != 3 || liveKey != nil {
		t.Fatalf("after settle: status=%s sessionsLeft=%d liveKey=%v; want active/3/nil", status, sessionsLeft, liveKey)
	}

	// The claim is released on settlement, so a second checkout is allowed.
	if code := checkout(); code != http.StatusCreated {
		t.Fatalf("checkout after settlement: %d, want 201", code)
	}
}

func TestIntegrationCarePlanVersionConflict(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	seedUser(t, email, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.login(email, "Patient@123")

	rec, body, text := c.request(http.MethodGet, "/api/care-plan", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get care plan: %d %s", rec.Code, text)
	}
	plan := dataObject(t, body)
	planID, _ := plan["id"].(string)
	if planID == "" {
		t.Fatalf("care plan has no id: %#v", plan)
	}
	if plan["version"].(float64) != 0 {
		t.Fatalf("new plan version = %v, want 0", plan["version"])
	}

	put := func(title string) int {
		cc := c.clone()
		rec, _, _ := cc.request(http.MethodPut, "/api/care-plan/"+planID, map[string]any{
			"version": 0, "title": title,
		})
		return rec.Code
	}

	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	titles := []string{"Plan A", "Plan B"}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			statuses <- put(titles[i])
		}(i)
	}
	wg.Wait()
	close(statuses)

	var ok, conflict int
	for code := range statuses {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		default:
			t.Fatalf("concurrent plan update returned %d; want 200 and 409", code)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("concurrent plan update: %d ok, %d conflicts; want one of each", ok, conflict)
	}

	rec, body, text = c.request(http.MethodGet, "/api/care-plan", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-read care plan: %d %s", rec.Code, text)
	}
	plan = dataObject(t, body)
	if plan["version"].(float64) != 1 {
		t.Fatalf("version after one successful write = %v, want 1", plan["version"])
	}
	if title, _ := plan["title"].(string); title != "Plan A" && title != "Plan B" {
		t.Fatalf("title after conflict = %q; want one of the submitted titles", title)
	}
	// One plan, not two: GET creates only when none exists.
	var plans int
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `CarePlan` WHERE userId = (SELECT id FROM `User` WHERE email = ?)", email).Scan(&plans); err != nil {
		t.Fatalf("count plans: %v", err)
	}
	if plans != 1 {
		t.Fatalf("care plans = %d, want 1", plans)
	}
}

func TestIntegrationReviewAggregateExcludesHidden(t *testing.T) {
	s := newIntegrationServer(t)
	patientEmail := uniqueEmail(t)
	patientID := seedUser(t, patientEmail, "Patient@123", "patient")
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Review")
	appointmentID := seedCompletedAppointment(t, patientID, doctorID)
	c := newTestClient(t, s.Mount())
	c.login(patientEmail, "Patient@123")

	rec, _, text := c.request(http.MethodPost, "/api/reviews", map[string]any{
		"doctorId": doctorID, "appointmentId": appointmentID, "rating": 4, "comment": "A useful session.",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create review: %d %s", rec.Code, text)
	}
	var reviewID string
	var rating float64
	var total int
	if err := itPool.QueryRow("SELECT id FROM `Review` WHERE appointmentId = ?", appointmentID).Scan(&reviewID); err != nil {
		t.Fatalf("read review id: %v", err)
	}
	if err := itPool.QueryRow("SELECT rating, totalReviews FROM `Doctor` WHERE id = ?", doctorID).
		Scan(&rating, &total); err != nil {
		t.Fatalf("read doctor aggregate: %v", err)
	}
	if rating != 4 || total != 1 {
		t.Fatalf("aggregate after review = %v/%d, want 4/1", rating, total)
	}

	// One review per appointment is a unique key, not a check-then-create.
	rec, _, _ = c.request(http.MethodPost, "/api/reviews", map[string]any{
		"doctorId": doctorID, "appointmentId": appointmentID, "rating": 5, "comment": "Second review.",
	})
	if rec.Code == http.StatusCreated {
		t.Fatal("a second review for the same appointment was accepted")
	}

	adminEmail := uniqueEmail(t)
	seedUser(t, adminEmail, "Admin@123", "admin")
	admin := newTestClient(t, s.Mount())
	admin.login(adminEmail, "Admin@123")
	rec, _, text = admin.request(http.MethodPost, "/api/admin/reviews/"+reviewID+"/hide", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("hide review: %d %s", rec.Code, text)
	}

	if err := itPool.QueryRow("SELECT rating, totalReviews FROM `Doctor` WHERE id = ?", doctorID).
		Scan(&rating, &total); err != nil {
		t.Fatalf("read aggregate after hide: %v", err)
	}
	if rating != 0 || total != 0 {
		t.Fatalf("aggregate after hide = %v/%d, want 0/0 (hidden reviews must not rate)", rating, total)
	}

	public := newTestClient(t, s.Mount())
	rec, _, text = public.request(http.MethodGet, "/api/reviews/doctor/"+doctorID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("public reviews: %d %s", rec.Code, text)
	}
	if strings.Contains(text, reviewID) {
		t.Fatal("the public listing includes a hidden review")
	}
}

func TestIntegrationRoleGuards(t *testing.T) {
	s := newIntegrationServer(t)
	patientEmail := uniqueEmail(t)
	seedUser(t, patientEmail, "Patient@123", "patient")
	doctorEmail := uniqueEmail(t)
	seedDoctor(t, doctorEmail, "Dr. Integration Guard")

	patient := newTestClient(t, s.Mount())
	patient.login(patientEmail, "Patient@123")
	doctor := newTestClient(t, s.Mount())
	doctor.login(doctorEmail, "Doctor@123")
	anonymous := newTestClient(t, s.Mount())

	cases := []struct {
		name   string
		client *testClient
		path   string
		want   int
	}{
		{"patient cannot read admin stats", patient, "/api/admin/stats", http.StatusForbidden},
		{"patient cannot read the pattern list", patient, "/api/doctors/patterns", http.StatusForbidden},
		{"doctor cannot read admin stats", doctor, "/api/admin/stats", http.StatusForbidden},
		{"doctor can read the pattern list", doctor, "/api/doctors/patterns", http.StatusOK},
		{"anonymous cannot read appointments", anonymous, "/api/appointments/my", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, _, text := tc.client.request(http.MethodGet, tc.path, nil)
			if rec.Code != tc.want {
				t.Fatalf("%s: %d %s; want %d", tc.path, rec.Code, text, tc.want)
			}
		})
	}
}

func TestIntegrationAccountExport(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	seedUser(t, email, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.login(email, "Patient@123")
	rec, _, text := c.request(http.MethodPost, "/api/wellness/mood", map[string]any{"mood": 4})
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed mood via API: %d %s", rec.Code, text)
	}

	rec, _, body := c.request(http.MethodGet, "/api/account/export", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, body)
	}
	if disposition := rec.Header().Get("Content-Disposition"); !strings.Contains(disposition, "attachment") {
		t.Fatalf("export Content-Disposition = %q; want an attachment", disposition)
	}
	if !strings.Contains(body, email) {
		t.Fatal("export does not contain the account email")
	}
	if !strings.Contains(body, "\"moods\"") {
		t.Fatal("export does not contain the mood history")
	}
}

func TestIntegrationInternalJobTrigger(t *testing.T) {
	s := newIntegrationServer(t)
	c := newTestClient(t, s.Mount())
	c.ensureCSRF()

	rec, _, _ := c.request(http.MethodPost, "/api/internal/jobs/reminders", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("trigger without secret: %d, want 401", rec.Code)
	}
	rec, _, _ = c.request(http.MethodPost, "/api/internal/jobs/reminders", nil,
		map[string]string{"X-Jobs-Secret": "wrong-secret"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("trigger with a wrong secret: %d, want 401", rec.Code)
	}
	rec, body, text := c.request(http.MethodPost, "/api/internal/jobs/reminders", nil,
		map[string]string{"X-Jobs-Secret": "integration-jobs-secret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("trigger with the secret: %d %s", rec.Code, text)
	}
	if job, _ := dataObject(t, body)["job"].(string); job != "reminders" {
		t.Fatalf("trigger payload job = %q, want reminders", job)
	}
	rec, _, _ = c.request(http.MethodPost, "/api/internal/jobs/no-such-job", nil,
		map[string]string{"X-Jobs-Secret": "integration-jobs-secret"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown job: %d, want 404", rec.Code)
	}

	// A deployment without the secret answers 404 rather than advertising the
	// endpoint exists.
	cfg := testConfig(t)
	cfg.JobsSecret = ""
	unconfigured := newTestClient(t, New(cfg, itPool, nil, itLog).Mount())
	unconfigured.ensureCSRF()
	rec, _, _ = unconfigured.request(http.MethodPost, "/api/internal/jobs/reminders", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unconfigured trigger: %d, want 404", rec.Code)
	}
}

func TestIntegrationMoodOnePerDay(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	seedUser(t, email, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.login(email, "Patient@123")

	rec, body, text := c.request(http.MethodPost, "/api/wellness/mood", map[string]any{"mood": 3})
	if rec.Code != http.StatusCreated {
		t.Fatalf("first mood: %d %s", rec.Code, text)
	}
	if replaced, _ := dataObject(t, body)["replaced"].(bool); replaced {
		t.Fatal("the first mood entry of the day reported replaced=true")
	}
	rec, body, text = c.request(http.MethodPost, "/api/wellness/mood", map[string]any{"mood": 5})
	if rec.Code != http.StatusCreated {
		t.Fatalf("second mood: %d %s", rec.Code, text)
	}
	if replaced, _ := dataObject(t, body)["replaced"].(bool); !replaced {
		t.Fatal("the second mood entry of the day reported replaced=false")
	}
	var count int
	var mood int
	if err := itPool.QueryRow(
		"SELECT COUNT(*), MAX(mood) FROM `MoodEntry` WHERE userId = (SELECT id FROM `User` WHERE email = ?)", email).
		Scan(&count, &mood); err != nil {
		t.Fatalf("read mood rows: %v", err)
	}
	if count != 1 || mood != 5 {
		t.Fatalf("mood rows = %d with mood %d; want one row updated to 5", count, mood)
	}
}

func TestIntegrationIdentifiersAreUUIDv7(t *testing.T) {
	s := newIntegrationServer(t)
	c := newTestClient(t, s.Mount())
	c.ensureCSRF()
	rec, body, text := c.request(http.MethodPost, "/api/auth/register", map[string]any{
		"email": uniqueEmail(t), "password": "Patient@123", "name": "UUID Test", "role": "patient",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, text)
	}
	id := dataObject(t, body)["user"].(map[string]any)["id"].(string)
	if !uuid7Pattern.MatchString(id) {
		t.Fatalf("user id %q is not a UUIDv7", id)
	}
}

var uuid7Pattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
