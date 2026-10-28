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
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

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

func TestIntegrationTwoFactorReplayAndBackupCodes(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	seedUser(t, email, "Patient@123", "patient")

	setup := newTestClient(t, s.Mount())
	setup.login(email, "Patient@123")
	rec, body, text := setup.request(http.MethodPost, "/api/account/2fa/setup",
		map[string]any{"password": "Patient@123"})
	if rec.Code != http.StatusOK {
		t.Fatalf("2fa setup: %d %s", rec.Code, text)
	}
	secret, _ := dataObject(t, body)["secret"].(string)
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate TOTP: %v", err)
	}

	rec, body, text = setup.request(http.MethodPost, "/api/account/2fa/enable",
		map[string]any{"code": code})
	if rec.Code != http.StatusOK {
		t.Fatalf("2fa enable: %d %s", rec.Code, text)
	}
	rawCodes, ok := dataObject(t, body)["backupCodes"].([]any)
	if !ok || len(rawCodes) < 2 {
		t.Fatalf("backup codes = %#v; want at least two", dataObject(t, body)["backupCodes"])
	}
	backups := make([]string, 0, len(rawCodes))
	for _, raw := range rawCodes {
		value, _ := raw.(string)
		backups = append(backups, value)
	}

	pendingToken := func() string {
		client := newTestClient(t, s.Mount())
		client.ensureCSRF()
		rec, body, text := client.request(http.MethodPost, "/api/auth/login",
			map[string]any{"email": email, "password": "Patient@123"})
		if rec.Code != http.StatusOK {
			t.Fatalf("2fa login: %d %s", rec.Code, text)
		}
		data := dataObject(t, body)
		if required, _ := data["requires2FA"].(bool); !required {
			t.Fatalf("login did not require a second factor: %s", text)
		}
		token, _ := data["twoFactorToken"].(string)
		if token == "" {
			t.Fatalf("login returned no pending token: %s", text)
		}
		return token
	}
	verify := func(token, candidate string) int {
		client := newTestClient(t, s.Mount())
		client.ensureCSRF()
		rec, _, _ := client.request(http.MethodPost, "/api/account/2fa/verify",
			map[string]any{"token": token, "code": candidate})
		return rec.Code
	}

	if got := verify(pendingToken(), code); got != http.StatusOK {
		t.Fatalf("first TOTP verification: %d, want 200", got)
	}
	// The same code inside the accepted step window is a replay.
	if got := verify(pendingToken(), code); got != http.StatusUnauthorized {
		t.Fatalf("replayed TOTP code: %d, want 401", got)
	}

	// A backup code is single-use, and consuming one must not invalidate the
	// others.
	if got := verify(pendingToken(), backups[0]); got != http.StatusOK {
		t.Fatalf("first backup code: %d, want 200", got)
	}
	if got := verify(pendingToken(), backups[0]); got != http.StatusUnauthorized {
		t.Fatalf("replayed backup code: %d, want 401", got)
	}
	if got := verify(pendingToken(), backups[1]); got != http.StatusOK {
		t.Fatalf("second backup code: %d, want 200", got)
	}
}

func itAssertKeys(t *testing.T, object map[string]any, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if _, present := object[key]; !present {
			t.Errorf("response shape is missing %q (keys: %v)", key, objectKeys(object))
		}
	}
}

func itAssertAbsent(t *testing.T, object map[string]any, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if _, present := object[key]; present {
			t.Errorf("response shape leaks %q", key)
		}
	}
}

func objectKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	return keys
}

// TestIntegrationResponseShapes pins the wire shapes the client reads. The
// OpenAPI component schemas describe them, and this test proves the handlers
// actually emit the fields they document (and nothing credential-shaped).
func seedAssessment(t *testing.T, userID, kind string, score int, severity string, createdAt time.Time) string {
	t.Helper()
	id := newID()
	_, err := itPool.ExecContext(context.Background(),
		"INSERT INTO `Assessment` (id, userId, type, answersJson, score, severity, createdAt) VALUES (?,?,?,?,?,?,?)",
		id, userID, kind, "{}", score, severity, createdAt)
	if err != nil {
		t.Fatalf("seed assessment: %v", err)
	}
	return id
}

// seedConfirmedAppointmentSoon creates a session two hours from now, with the
// appointment date anchored at UTC midnight of its WIB day - the same shape the
// seed and booking path write.
func seedConfirmedAppointmentSoon(t *testing.T, userID, doctorID string) string {
	t.Helper()
	start := time.Now().In(itLocation).Add(2 * time.Hour)
	date := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	now := time.Now().UTC()
	id := newID()
	_, err := itPool.ExecContext(context.Background(),
		"INSERT INTO `Appointment` (id, userId, doctorId, appointmentDate, startTime, endTime, consultationType, status, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?)",
		id, userID, doctorID, date, start.Format("15:04"), start.Add(time.Hour).Format("15:04"),
		"video", "confirmed", now, now)
	if err != nil {
		t.Fatalf("seed confirmed appointment: %v", err)
	}
	return id
}

func notificationCount(t *testing.T, userID string) int {
	t.Helper()
	var count int
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `Notification` WHERE userId = ?", userID).Scan(&count); err != nil {
		t.Fatalf("count notifications for %s: %v", userID, err)
	}
	return count
}

func TestIntegrationReminderClaimAndHandBack(t *testing.T) {
	s := newIntegrationServer(t)
	ctx := context.Background()

	patientID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	doctorUserID, doctorID := seedDoctor(t, uniqueEmail(t), "Dr Reminder")
	first := seedConfirmedAppointmentSoon(t, patientID, doctorID)

	due, sent, err := s.jobsRemindersTick(ctx)
	if err != nil {
		t.Fatalf("first reminder tick: %v", err)
	}
	if due != 1 || sent != 1 {
		t.Fatalf("first tick: due=%d sent=%d, want 1/1", due, sent)
	}
	var reminderSent sql.NullTime
	if err := itPool.QueryRow("SELECT reminderSentAt FROM `Appointment` WHERE id = ?", first).Scan(&reminderSent); err != nil {
		t.Fatalf("read claim: %v", err)
	}
	if !reminderSent.Valid {
		t.Fatal("a delivered reminder did not stamp reminderSentAt")
	}
	if got := notificationCount(t, patientID) + notificationCount(t, doctorUserID); got != 2 {
		t.Fatalf("first run created %d notifications, want 2", got)
	}

	// The claim is what makes a second run silent, not the clock.
	due, sent, err = s.jobsRemindersTick(ctx)
	if err != nil {
		t.Fatalf("second reminder tick: %v", err)
	}
	if due != 0 || sent != 0 {
		t.Fatalf("second tick: due=%d sent=%d, want 0/0", due, sent)
	}
	if got := notificationCount(t, patientID) + notificationCount(t, doctorUserID); got != 2 {
		t.Fatalf("second run duplicated notifications: %d", got)
	}

	// Force both in-app deliveries to fail. The claim must be handed back, or
	// a transient database problem silently consumes the only reminder.
	second := seedConfirmedAppointmentSoon(t, patientID, doctorID)
	if _, err := itPool.ExecContext(ctx,
		"CREATE TRIGGER `integration_fail_notification` BEFORE INSERT ON `Notification` "+
			"FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced notification failure'"); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}
	due, sent, err = s.jobsRemindersTick(ctx)
	if err != nil {
		t.Fatalf("failing reminder tick: %v", err)
	}
	if due != 1 || sent != 0 {
		t.Fatalf("failing tick: due=%d sent=%d, want 1/0", due, sent)
	}
	var retryClaim sql.NullTime
	if err := itPool.QueryRow("SELECT reminderSentAt FROM `Appointment` WHERE id = ?", second).Scan(&retryClaim); err != nil {
		t.Fatalf("read released claim: %v", err)
	}
	if retryClaim.Valid {
		t.Fatal("a failed delivery kept reminderSentAt; the next run would never retry")
	}

	// With delivery working again, the retry succeeds.
	if _, err := itPool.ExecContext(ctx, "DROP TRIGGER IF EXISTS `integration_fail_notification`"); err != nil {
		t.Fatalf("drop failure trigger: %v", err)
	}
	due, sent, err = s.jobsRemindersTick(ctx)
	if err != nil {
		t.Fatalf("retry tick: %v", err)
	}
	if due != 1 || sent != 1 {
		t.Fatalf("retry tick: due=%d sent=%d, want 1/1", due, sent)
	}
	if err := itPool.QueryRow("SELECT reminderSentAt FROM `Appointment` WHERE id = ?", second).Scan(&retryClaim); err != nil {
		t.Fatalf("read retried claim: %v", err)
	}
	if !retryClaim.Valid {
		t.Fatal("the retried reminder did not stamp reminderSentAt")
	}
}

func TestIntegrationWeeklyReportClaimsOncePerWeek(t *testing.T) {
	s := newIntegrationServer(t)
	ctx := context.Background()
	email := uniqueEmail(t)
	patientID := seedUser(t, email, "Patient@123", "patient")
	if _, err := itPool.ExecContext(ctx,
		"UPDATE `User` SET weeklyReportEnabled = TRUE, lastWeeklyReportAt = NULL WHERE id = ?", patientID); err != nil {
		t.Fatalf("enable weekly report: %v", err)
	}

	sent, failed, _, err := s.jobsWeeklyReportsTick(ctx)
	if err != nil {
		t.Fatalf("first weekly tick: %v", err)
	}
	if sent != 1 || failed != 0 {
		t.Fatalf("first weekly tick: sent=%d failed=%d, want 1/0", sent, failed)
	}
	if got := notificationCount(t, patientID); got != 1 {
		t.Fatalf("first weekly tick created %d notifications, want 1", got)
	}
	var stamped sql.NullTime
	if err := itPool.QueryRow("SELECT lastWeeklyReportAt FROM `User` WHERE id = ?", patientID).Scan(&stamped); err != nil {
		t.Fatalf("read weekly claim: %v", err)
	}
	if !stamped.Valid {
		t.Fatal("weekly report did not stamp lastWeeklyReportAt")
	}

	// The same week is claimed; a second run is silent.
	sent, failed, _, err = s.jobsWeeklyReportsTick(ctx)
	if err != nil {
		t.Fatalf("second weekly tick: %v", err)
	}
	if sent != 0 || failed != 0 {
		t.Fatalf("second weekly tick: sent=%d failed=%d, want 0/0", sent, failed)
	}
	if got := notificationCount(t, patientID); got != 1 {
		t.Fatalf("second weekly tick duplicated the report: %d notifications", got)
	}

	// A missed Monday is caught up by the next daily run: the sentinel is
	// older than this week's start, so the claim reopens.
	if _, err := itPool.ExecContext(ctx,
		"UPDATE `User` SET lastWeeklyReportAt = ? WHERE id = ?",
		time.Now().UTC().AddDate(0, 0, -8), patientID); err != nil {
		t.Fatalf("simulate missed week: %v", err)
	}
	sent, failed, _, err = s.jobsWeeklyReportsTick(ctx)
	if err != nil {
		t.Fatalf("catch-up weekly tick: %v", err)
	}
	if sent != 1 || failed != 0 {
		t.Fatalf("catch-up tick: sent=%d failed=%d, want 1/0", sent, failed)
	}
	if got := notificationCount(t, patientID); got != 2 {
		t.Fatalf("catch-up tick produced %d notifications, want 2", got)
	}
}

func TestIntegrationAssessmentTrajectoryWindowAndDirection(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	patientID := seedUser(t, email, "Patient@123", "patient")
	now := time.Now().UTC()
	seedAssessment(t, patientID, "phq9", 4, "minimal", now.AddDate(0, 0, -20))
	seedAssessment(t, patientID, "phq9", 9, "mild", now.AddDate(0, 0, -10))
	seedAssessment(t, patientID, "phq9", 15, "moderately severe", now.AddDate(0, 0, -2))

	c := newTestClient(t, s.Mount())
	c.login(email, "Patient@123")

	rec, body, text := c.request(http.MethodGet, "/api/wellness/assessments/trajectory?type=phq9", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("trajectory: %d %s", rec.Code, text)
	}
	data := dataObject(t, body)
	summary, ok := data["summary"].(map[string]any)
	if !ok {
		t.Fatalf("trajectory summary missing: %#v", data)
	}
	if summary["sittings"] != float64(3) {
		t.Fatalf("sittings = %v, want 3", summary["sittings"])
	}
	if summary["first"] != float64(4) || summary["latest"] != float64(15) || summary["totalChange"] != float64(11) {
		t.Fatalf("unexpected trajectory summary: %#v", summary)
	}
	if summary["direction"] != "worsening" {
		t.Fatalf("direction = %v, want worsening", summary["direction"])
	}
	points, ok := data["points"].([]any)
	if !ok || len(points) != 3 {
		t.Fatalf("points = %#v, want 3", data["points"])
	}
	third := points[2].(map[string]any)
	if third["score"] != float64(15) || third["changeFromPrevious"] != float64(6) {
		t.Fatalf("latest point = %#v, want score 15 and change 6", third)
	}
	if points[0].(map[string]any)["changeFromPrevious"] != nil {
		t.Fatalf("the first point should have no previous change: %#v", points[0])
	}

	// The window must take the newest sittings. Ordering before LIMIT is what
	// makes `latest` the current score rather than an old one.
	rec, body, text = c.request(http.MethodGet, "/api/wellness/assessments/trajectory?type=phq9&limit=2", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("limited trajectory: %d %s", rec.Code, text)
	}
	limited := dataObject(t, body)["summary"].(map[string]any)
	if limited["sittings"] != float64(2) || limited["first"] != float64(9) || limited["latest"] != float64(15) {
		t.Fatalf("limited window = %#v, want the newest two sittings", limited)
	}
	// Two sittings is not enough for a direction; the API says so instead of
	// drawing a confident trend from noise.
	if limited["direction"] != "insufficient-data" {
		t.Fatalf("limited direction = %v, want insufficient-data", limited["direction"])
	}
}

func TestIntegrationAdminExportKinds(t *testing.T) {
	s := newIntegrationServer(t)
	adminEmail := uniqueEmail(t)
	seedUser(t, adminEmail, "Admin@123", "admin")
	patientID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr Export")
	seedCompletedAppointment(t, patientID, doctorID)

	c := newTestClient(t, s.Mount())
	c.login(adminEmail, "Admin@123")

	bookingsHeader := "id,patient,patientEmail,doctor,date,time,type,status,price,createdAt"
	cases := []struct {
		kind     string
		filename string
		header   string
	}{
		{"users", "mindease-users.csv", "id,name,email,role,provider,banned,createdAt"},
		{"revenue", "mindease-revenue.csv", "doctorId,doctor,completedBookings,revenue,rate"},
		{"bookings", "mindease-bookings.csv", bookingsHeader},
		// An unlisted kind deliberately falls through to the bookings
		// dataset rather than returning an error.
		{"not-a-real-kind", "mindease-bookings.csv", bookingsHeader},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			rec, _, text := c.request(http.MethodGet, "/api/admin/export/"+tc.kind, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s export: %d %s", tc.kind, rec.Code, text)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/csv") {
				t.Fatalf("%s Content-Type = %q", tc.kind, got)
			}
			if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, tc.filename) {
				t.Fatalf("%s Content-Disposition = %q, want %s", tc.kind, got, tc.filename)
			}
			if !strings.HasPrefix(text, tc.header) {
				t.Fatalf("%s CSV does not start with the expected header:\n%s", tc.kind, text)
			}
		})
	}
}

func TestIntegrationResponseShapes(t *testing.T) {
	s := newIntegrationServer(t)
	email := uniqueEmail(t)
	userID := seedUser(t, email, "Patient@123", "patient")
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Shape")
	slotID, dayKey := seedSlot(t, doctorID, 3, "09:00", "10:00")
	c := newTestClient(t, s.Mount())
	c.login(email, "Patient@123")

	rec, body, text := c.request(http.MethodGet, "/api/users/profile", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("profile: %d %s", rec.Code, text)
	}
	profile := dataObject(t, body)
	itAssertKeys(t, profile, "id", "email", "name", "role", "provider", "createdAt")
	itAssertAbsent(t, profile, "password", "totpSecret", "backupCodes", "resetOtpHash", "verifyOtpHash")

	rec, body, text = c.request(http.MethodGet, "/api/doctors?limit=5", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("doctors: %d %s", rec.Code, text)
	}
	doctors := dataObject(t, body)
	itAssertKeys(t, doctors, "rows", "total", "page", "totalPages")
	rows, _ := doctors["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("doctors list is empty after seeding a clinician")
	}
	first := rows[0].(map[string]any)
	itAssertKeys(t, first, "id", "specialty", "user", "_count")

	rec, body, text = c.request(http.MethodGet, "/api/doctors/"+doctorID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("doctor detail: %d %s", rec.Code, text)
	}
	itAssertKeys(t, dataObject(t, body), "id", "specialty", "bio", "user", "consultationSlots")

	rec, body, text = c.request(http.MethodPost, "/api/wellness/mood", map[string]any{"mood": 4})
	if rec.Code != http.StatusCreated {
		t.Fatalf("mood: %d %s", rec.Code, text)
	}
	itAssertKeys(t, dataObject(t, body), "id", "userId", "mood", "moodDate", "replaced")
	rec, body, text = c.request(http.MethodGet, "/api/wellness/mood", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("mood list: %d %s", rec.Code, text)
	}
	array, _ := body["data"].([]any)
	if len(array) != 1 {
		t.Fatalf("mood list length = %d", len(array))
	}
	itAssertKeys(t, array[0].(map[string]any), "id", "userId", "mood", "moodDate")

	rec, _, text = c.request(http.MethodPost, "/api/wellness/journal", map[string]any{"content": "Shape fixture entry."})
	if rec.Code != http.StatusCreated {
		t.Fatalf("journal create: %d %s", rec.Code, text)
	}
	rec, body, text = c.request(http.MethodGet, "/api/wellness/journal", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("journal list: %d %s", rec.Code, text)
	}
	array, _ = body["data"].([]any)
	if len(array) != 1 {
		t.Fatalf("journal list length = %d", len(array))
	}
	itAssertKeys(t, array[0].(map[string]any), "id", "userId", "content")

	if _, err := itPool.Exec(
		"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), userID, "Shape", "Fixture notification", false, "system", time.Now().UTC()); err != nil {
		t.Fatalf("seed notification: %v", err)
	}
	rec, body, text = c.request(http.MethodGet, "/api/notifications", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("notifications: %d %s", rec.Code, text)
	}
	notifications := dataObject(t, body)
	itAssertKeys(t, notifications, "rows", "total", "page", "totalPages")
	nrows, _ := notifications["rows"].([]any)
	if len(nrows) != 1 {
		t.Fatalf("notification rows = %d", len(nrows))
	}
	itAssertKeys(t, nrows[0].(map[string]any), "id", "title", "message", "isRead")

	rec, _, text = c.request(http.MethodPost, "/api/appointments/book", map[string]any{
		"doctorId": doctorID, "appointmentDate": dayKey, "startTime": "09:00", "endTime": "10:00",
		"consultationType": "video", "slotId": slotID,
		"idempotencyKey": "shape-" + newID(),
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("book: %d %s", rec.Code, text)
	}
	rec, body, text = c.request(http.MethodGet, "/api/appointments/my", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("appointments: %d %s", rec.Code, text)
	}
	appointments := dataObject(t, body)
	itAssertKeys(t, appointments, "rows", "total", "page", "totalPages")
	arows, _ := appointments["rows"].([]any)
	if len(arows) != 1 {
		t.Fatalf("appointment rows = %d", len(arows))
	}
	itAssertKeys(t, arows[0].(map[string]any), "id", "status", "appointmentDate", "doctor")

	rec, body, text = c.request(http.MethodGet, "/api/care-plan", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("care plan: %d %s", rec.Code, text)
	}
	itAssertKeys(t, dataObject(t, body), "id", "userId", "title", "status", "version", "goals")

	rec, body, text = c.request(http.MethodGet, "/api/safety-plan", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("safety plan: %d %s", rec.Code, text)
	}
	if body["data"] != nil {
		t.Fatalf("safety plan for a fresh account = %#v; want null", body["data"])
	}

	rec, body, text = c.request(http.MethodGet, "/api/reviews/doctor/"+doctorID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("public reviews: %d %s", rec.Code, text)
	}
	if _, ok := body["pagination"].(map[string]any); !ok {
		t.Errorf("public reviews have no pagination object: %v", objectKeys(body))
	}

	rec, body, text = c.request(http.MethodGet, "/api/payments/config", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("payment config: %d %s", rec.Code, text)
	}
	config := dataObject(t, body)
	itAssertKeys(t, config, "mode", "simulated")
}

func TestIntegrationPublicDoctorReviewsArePseudonymous(t *testing.T) {
	s := newIntegrationServer(t)
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Reviews")
	patientEmail := uniqueEmail(t)
	patientID := seedUser(t, patientEmail, "Patient@123", "patient")
	apptID := seedCompletedAppointment(t, patientID, doctorID)
	c := newTestClient(t, s.Mount())
	c.login(patientEmail, "Patient@123")

	rec, _, text := c.request(http.MethodPost, "/api/reviews", map[string]any{
		"doctorId": doctorID, "appointmentId": apptID, "rating": 5,
		"comment": "Very helpful session, thank you.",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create review: %d %s", rec.Code, text)
	}

	// Public, unauthenticated: the reviewer's identity must never appear.
	pub := newTestClient(t, s.Mount())
	rec, body, text := pub.request(http.MethodGet, "/api/doctors/"+doctorID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("public doctor detail: %d %s", rec.Code, text)
	}
	reviews, ok := dataObject(t, body)["reviews"].([]any)
	if !ok || len(reviews) != 1 {
		t.Fatalf("want 1 public review, got %#v", dataObject(t, body)["reviews"])
	}
	rev, ok := reviews[0].(map[string]any)
	if !ok {
		t.Fatalf("review is not an object: %#v", reviews[0])
	}
	if user, present := rev["user"]; present {
		t.Fatalf("public review exposes reviewer identity: %#v", user)
	}
	if name, _ := rev["displayName"].(string); name == "" {
		t.Fatalf("public review has no displayName: %#v", rev)
	}
	if strings.Contains(rec.Body.String(), patientEmail) {
		t.Fatalf("public doctor detail leaks the reviewer email")
	}
}

func TestIntegrationPatientAppointmentListHasNoBriefing(t *testing.T) {
	s := newIntegrationServer(t)
	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Privacy")
	slotID, dayKey := seedSlot(t, doctorID, 3, "09:00", "10:00")
	patientEmail := uniqueEmail(t)
	seedUser(t, patientEmail, "Patient@123", "patient")
	c := newTestClient(t, s.Mount())
	c.login(patientEmail, "Patient@123")

	rec, _, text := c.request(http.MethodPost, "/api/appointments/book", map[string]any{
		"doctorId":         doctorID,
		"appointmentDate":  dayKey,
		"startTime":        "09:00",
		"endTime":          "10:00",
		"consultationType": "video",
		"slotId":           slotID,
		"idempotencyKey":   "it-no-briefing",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("book: %d %s", rec.Code, text)
	}

	rec, body, text := c.request(http.MethodGet, "/api/appointments/my", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("my appointments: %d %s", rec.Code, text)
	}
	rows, _ := dataObject(t, body)["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("appointment rows = %d; want 1", len(rows))
	}
	row, _ := rows[0].(map[string]any)
	if _, present := row["preSessionData"]; present {
		t.Fatalf("patient appointment list embeds pre-session data")
	}
	if strings.Contains(rec.Body.String(), "briefingText") {
		t.Fatalf("patient appointment list leaks the clinician briefing")
	}
}

func TestIntegrationSOSWithoutAppointmentCreatesUnassignedAlert(t *testing.T) {
	s := newIntegrationServer(t)
	patientEmail := uniqueEmail(t)
	patientID := seedUser(t, patientEmail, "Patient@123", "patient")
	adminEmail := uniqueEmail(t)
	adminID := seedUser(t, adminEmail, "Admin@123", "admin")
	c := newTestClient(t, s.Mount())
	c.login(patientEmail, "Patient@123")

	rec, body, text := c.request(http.MethodPost, "/api/support/sos", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("sos: %d %s", rec.Code, text)
	}
	data := dataObject(t, body)
	if recorded, _ := data["recorded"].(bool); !recorded {
		t.Fatalf("sos without a clinician was not recorded: %#v", data)
	}

	var alertID, sourceType string
	var assigned sql.NullString
	if err := itPool.QueryRow(
		"SELECT id, sourceType, assignedDoctorUserId FROM `RiskAlert` WHERE userId = ?", patientID).
		Scan(&alertID, &sourceType, &assigned); err != nil {
		t.Fatalf("read risk alert: %v", err)
	}
	if sourceType != "sos" {
		t.Fatalf("alert source = %q; want sos", sourceType)
	}
	if assigned.Valid {
		t.Fatalf("unassigned SOS alert has assignedDoctorUserId = %q", assigned.String)
	}

	var adminNotifs int
	if err := itPool.QueryRow(
		"SELECT COUNT(*) FROM `Notification` WHERE userId = ? AND title = 'Risk disclosure awaiting review'", adminID).
		Scan(&adminNotifs); err != nil {
		t.Fatalf("count admin notifications: %v", err)
	}
	if adminNotifs != 1 {
		t.Fatalf("admin notifications = %d; want 1", adminNotifs)
	}

	// An admin can work the unassigned alert: acknowledge then resolve.
	admin := newTestClient(t, s.Mount())
	admin.login(adminEmail, "Admin@123")
	rec, _, text = admin.request(http.MethodPost, "/api/wellness/risk-alerts/"+alertID+"/acknowledge", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin acknowledge: %d %s", rec.Code, text)
	}
	rec, _, text = admin.request(http.MethodPost, "/api/wellness/risk-alerts/"+alertID+"/resolve",
		map[string]any{"note": "Called the patient back; hotlines confirmed."})
	if rec.Code != http.StatusOK {
		t.Fatalf("admin resolve: %d %s", rec.Code, text)
	}
}

func TestIntegrationUploadsListingIsRejected(t *testing.T) {
	s := newIntegrationServer(t)
	c := newTestClient(t, s.Mount())
	rec, _, text := c.request(http.MethodGet, "/uploads/", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /uploads/ = %d %s; want 404, not a directory listing", rec.Code, text)
	}
}

func putMultipartProfile(t *testing.T, c *testClient, h http.Handler, fields map[string]string) (*httptest.ResponseRecorder, map[string]any, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/users/profile", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for _, cookie := range c.cookies {
		req.AddCookie(cookie)
	}
	if c.csrf != "" {
		req.Header.Set("X-CSRF-Token", c.csrf)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	for _, cookie := range rec.Result().Cookies() {
		c.cookies[cookie.Name] = cookie
	}
	text := rec.Body.String()
	var parsed map[string]any
	if text != "" {
		_ = json.Unmarshal([]byte(text), &parsed)
	}
	return rec, parsed, text
}

func TestIntegrationProfileUpdatePersists(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	patientEmail := uniqueEmail(t)
	patientID := seedUser(t, patientEmail, "Patient@123", "patient")
	c := newTestClient(t, h)
	c.login(patientEmail, "Patient@123")

	rec, body, text := putMultipartProfile(t, c, h, map[string]string{
		"name": "Updated Name", "phone_number": "+62-812-0000", "weeklyReportEnabled": "true",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("patient profile update: %d %s", rec.Code, text)
	}
	if got := dataObject(t, body)["user"].(map[string]any)["name"].(string); got != "Updated Name" {
		t.Fatalf("profile name = %q; want Updated Name", got)
	}
	var phone sql.NullString
	var weekly bool
	if err := itPool.QueryRow("SELECT phone_number, weeklyReportEnabled FROM `User` WHERE id = ?",
		patientID).Scan(&phone, &weekly); err != nil {
		t.Fatalf("read user: %v", err)
	}
	if !phone.Valid || phone.String != "+62-812-0000" || !weekly {
		t.Fatalf("persisted phone=%v weekly=%v; want +62-812-0000 and true", phone, weekly)
	}

	doctorEmail := uniqueEmail(t)
	doctorUserID, doctorID := seedDoctor(t, doctorEmail, "Dr. Integration Profile")
	d := newTestClient(t, h)
	d.login(doctorEmail, "Doctor@123")

	rec, _, text = putMultipartProfile(t, d, h, map[string]string{
		"name": "Dr. Updated", "specialty": "Trauma", "price": "350000",
		"licenseNumber": "STR-123", "licenseIssuer": "Konsil Kedokteran",
		"experience": "9", "bio": "Trauma specialist.",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("doctor profile update: %d %s", rec.Code, text)
	}
	var specialty, license sql.NullString
	var price int
	var status string
	if err := itPool.QueryRow("SELECT specialty, price, licenseNumber, verificationStatus FROM `Doctor` WHERE id = ?",
		doctorID).Scan(&specialty, &price, &license, &status); err != nil {
		t.Fatalf("read doctor: %v", err)
	}
	if !specialty.Valid || specialty.String != "Trauma" || price != 350000 ||
		!license.Valid || license.String != "STR-123" {
		t.Fatalf("persisted specialty=%v price=%d license=%v", specialty, price, license)
	}
	if status != "approved" {
		t.Fatalf("verification status = %q; an edit must not silently unlist the doctor", status)
	}

	rec, body, text = d.request(http.MethodGet, "/api/users/profile", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("profile read-back: %d %s", rec.Code, text)
	}
	doctorProfile, _ := dataObject(t, body)["doctorProfile"].(map[string]any)
	if doctorProfile["specialty"] != "Trauma" || doctorProfile["licenseNumber"] != "STR-123" {
		t.Fatalf("read-back doctor profile = %#v", doctorProfile)
	}
	_ = doctorUserID
}
