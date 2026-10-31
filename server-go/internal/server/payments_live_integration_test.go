package server

// The live payment path: checkout through the Midtrans Snap API, then a
// signature-verified webhook settling the order. The unit tests pin the
// signature and status collapse; these run the real handler chain over HTTP
// with a fake provider, so the money path is exercised end to end without
// touching a real gateway.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSnap is a stand-in for Midtrans Snap. It records the requests it saw and
// answers in the provider's envelope, with a switch for the failure modes.
type fakeSnap struct {
	mu       sync.Mutex
	requests []map[string]any
	auth     []string
	mode     string // "" (success), "reject", "incomplete"
	server   *httptest.Server
}

func newFakeSnap(t *testing.T) *fakeSnap {
	t.Helper()
	f := &fakeSnap{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.requests = append(f.requests, body)
		mode := f.mode
		f.mu.Unlock()

		if r.URL.Path != "/snap/v1/transactions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch mode {
		case "reject":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error_messages":["unauthorized"]}`))
		case "incomplete":
			_, _ = w.Write([]byte(`{"token":"tok-only"}`))
		default:
			_, _ = w.Write([]byte(`{"token":"snap-token","redirect_url":"https://snap.example/pay/snap-token"}`))
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeSnap) lastRequest(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("the fake Snap endpoint received no requests")
	}
	return f.requests[len(f.requests)-1]
}

func (f *fakeSnap) lastAuth(t *testing.T) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.auth) == 0 {
		return ""
	}
	return f.auth[len(f.auth)-1]
}

func (f *fakeSnap) setMode(mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mode = mode
}

func newMidtransIntegrationServer(t *testing.T, baseURL string) *Server {
	t.Helper()
	s := newIntegrationServer(t)
	s.Cfg.PaymentMode = "midtrans"
	s.Cfg.PaymentServerKey = "midtrans-server-key"
	s.Cfg.PaymentClientKey = "midtrans-client-key"
	s.Cfg.PaymentBaseURL = baseURL
	return s
}

func TestIntegrationLiveCheckoutAndWebhookSettlement(t *testing.T) {
	snap := newFakeSnap(t)
	s := newMidtransIntegrationServer(t, snap.server.URL)
	h := s.Mount()

	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Live Pay")
	packageID := seedPackage(t, doctorID, 3, 300000)
	patientEmail := uniqueEmail(t)
	userID := seedUser(t, patientEmail, "Patient@123", "patient")
	c := newTestClient(t, h)
	c.login(patientEmail, "Patient@123")

	rec, body, text := c.request(http.MethodPost, "/api/payments/packages/"+packageID+"/checkout", nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("live checkout: %d %s", rec.Code, text)
	}
	data := dataObject(t, body)
	if got, _ := data["checkoutUrl"].(string); got != "https://snap.example/pay/snap-token" {
		t.Fatalf("checkoutUrl = %q; want the provider redirect", got)
	}
	if sim, _ := data["simulated"].(bool); sim {
		t.Fatal("live checkout reported simulated=true")
	}
	orderID, _ := data["orderId"].(string)
	if orderID == "" {
		t.Fatal("live checkout returned no orderId")
	}

	// The provider was called with Basic auth over the server key, the order it
	// was told about, and the package price.
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(s.Cfg.PaymentServerKey+":"))
	if got := snap.lastAuth(t); got != wantAuth {
		t.Fatalf("Snap Authorization = %q; want %q", got, wantAuth)
	}
	sent := snap.lastRequest(t)
	details, _ := sent["transaction_details"].(map[string]any)
	if details["order_id"] != orderID || details["gross_amount"] != float64(300000) {
		t.Fatalf("Snap transaction_details = %#v; want order %s at 300000", details, orderID)
	}

	// The claim is held and neither row is settled while the provider is the
	// only authority that has seen the money.
	var purchaseStatus, orderStatus string
	var liveKey *string
	if err := itPool.QueryRow(
		"SELECT p.status, o.status, p.liveKey FROM `PackagePurchase` p JOIN `PaymentOrder` o ON o.purchaseId = p.id WHERE o.orderId = ?",
		orderID).Scan(&purchaseStatus, &orderStatus, &liveKey); err != nil {
		t.Fatalf("read live checkout rows: %v", err)
	}
	if purchaseStatus != "pending" || orderStatus != "pending" || liveKey == nil {
		t.Fatalf("pre-settlement = %s/%s/liveKey=%v; want pending/pending/held", purchaseStatus, orderStatus, liveKey)
	}

	// `settlement` is authorised, not captured: record it, grant nothing.
	rec, body, text = c.request(http.MethodPost, "/api/payments/notification",
		json.RawMessage(midtransNotification(orderID, "200", "settlement", "300000.00", s.Cfg.PaymentServerKey)))
	if rec.Code != http.StatusOK {
		t.Fatalf("settlement webhook: %d %s", rec.Code, text)
	}
	if got := dataObject(t, body)["reason"]; got != "still_pending" {
		t.Fatalf("settlement reason = %v; want still_pending", got)
	}
	if err := itPool.QueryRow("SELECT sessionsLeft FROM `PackagePurchase` WHERE userId = ? AND packageId = ? AND status = 'pending'",
		userID, packageID).Scan(new(int)); err != nil {
		t.Fatalf("purchase missing after settlement: %v", err)
	}
	var sessionsAfterSettlement int
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `PackagePurchase` WHERE userId = ? AND packageId = ? AND status = 'active'",
		userID, packageID).Scan(&sessionsAfterSettlement); err != nil || sessionsAfterSettlement != 0 {
		t.Fatalf("active purchases after settlement = %d; want 0", sessionsAfterSettlement)
	}

	// `capture` settles exactly once and releases the claim.
	rec, body, text = c.request(http.MethodPost, "/api/payments/notification",
		json.RawMessage(midtransNotification(orderID, "200", "capture", "300000.00", s.Cfg.PaymentServerKey)))
	if rec.Code != http.StatusOK {
		t.Fatalf("capture webhook: %d %s", rec.Code, text)
	}
	if got := dataObject(t, body)["reason"]; got != "settled" {
		t.Fatalf("capture reason = %v; want settled", got)
	}
	var sessionsLeft int
	var settledAt *time.Time
	var settledStatus, ref string
	if err := itPool.QueryRow(
		"SELECT p.sessionsLeft, p.liveKey, o.status, o.settledAt, o.reference FROM `PackagePurchase` p "+
			"JOIN `PaymentOrder` o ON o.purchaseId = p.id WHERE o.orderId = ?", orderID).
		Scan(&sessionsLeft, &liveKey, &settledStatus, &settledAt, &ref); err != nil {
		t.Fatalf("read settled rows: %v", err)
	}
	if sessionsLeft != 3 || liveKey != nil || settledStatus != "paid" || settledAt == nil {
		t.Fatalf("settled = sessions %d, liveKey %v, order %s, settledAt %v; want 3/nil/paid/set",
			sessionsLeft, liveKey, settledStatus, settledAt)
	}
	if n := notificationCountFor(t, userID, "Your sessions are ready"); n != 1 {
		t.Fatalf("settlement notifications = %d; want 1", n)
	}

	// A provider retry must not grant a second entitlement.
	rec, body, text = c.request(http.MethodPost, "/api/payments/notification",
		json.RawMessage(midtransNotification(orderID, "200", "capture", "300000.00", s.Cfg.PaymentServerKey)))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate capture: %d %s", rec.Code, text)
	}
	if got := dataObject(t, body)["reason"]; got != "already_paid" {
		t.Fatalf("duplicate capture reason = %v; want already_paid", got)
	}
	if err := itPool.QueryRow("SELECT sessionsLeft FROM `PackagePurchase` WHERE id = (SELECT purchaseId FROM `PaymentOrder` WHERE orderId = ?)",
		orderID).Scan(&sessionsLeft); err != nil || sessionsLeft != 3 {
		t.Fatalf("sessions after replay = %d; want 3", sessionsLeft)
	}
}

func TestIntegrationLiveWebhookRejectsForgeryAndWrongAmount(t *testing.T) {
	snap := newFakeSnap(t)
	s := newMidtransIntegrationServer(t, snap.server.URL)
	h := s.Mount()

	_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Live Reject")
	packageID := seedPackage(t, doctorID, 3, 300000)
	patientEmail := uniqueEmail(t)
	seedUser(t, patientEmail, "Patient@123", "patient")
	c := newTestClient(t, h)
	c.login(patientEmail, "Patient@123")

	rec, body, text := c.request(http.MethodPost, "/api/payments/packages/"+packageID+"/checkout", nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("checkout: %d %s", rec.Code, text)
	}
	orderID, _ := dataObject(t, body)["orderId"].(string)

	cases := []struct {
		name string
		raw  string
	}{
		{
			// The attacker tampered with gross_amount but cannot re-sign it.
			name: "tampered amount with stale signature",
			raw: strings.Replace(
				midtransNotification(orderID, "200", "capture", "300000.00", s.Cfg.PaymentServerKey),
				"300000.00", "1.00", 1),
		},
		{
			name: "signed but wrong amount",
			raw:  midtransNotification(orderID, "200", "capture", "1.00", s.Cfg.PaymentServerKey),
		},
		{
			name: "expired/cancelled transaction",
			raw:  midtransNotification(orderID, "200", "expire", "300000.00", s.Cfg.PaymentServerKey),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, _, text := c.request(http.MethodPost, "/api/payments/notification", json.RawMessage(tc.raw))
			if tc.name == "expired/cancelled transaction" {
				if rec.Code != http.StatusOK {
					t.Fatalf("%s: %d %s; want 200 (released, not an error)", tc.name, rec.Code, text)
				}
				return
			}
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s: %d %s; want 400", tc.name, rec.Code, text)
			}
		})
	}

	// The expiry case released both rows, so nothing was granted.
	var rows int
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `PaymentOrder` WHERE orderId = ?", orderID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("payment order after expiry = %d; want 0 rows", rows)
	}
	var active int
	if err := itPool.QueryRow("SELECT COUNT(*) FROM `PackagePurchase` WHERE userId = (SELECT id FROM `User` WHERE email = ?) AND status = 'active'",
		patientEmail).Scan(&active); err != nil || active != 0 {
		t.Fatalf("active purchases after expiry = %d; want 0", active)
	}
}

func TestIntegrationLiveCheckoutFailureLeavesNoPhantomRows(t *testing.T) {
	cases := []struct {
		name    string
		mode    string
		wantErr int
	}{
		{"provider rejects", "reject", http.StatusBadRequest},
		{"provider returns an incomplete session", "incomplete", http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap := newFakeSnap(t)
			snap.setMode(tc.mode)
			s := newMidtransIntegrationServer(t, snap.server.URL)
			h := s.Mount()

			_, doctorID := seedDoctor(t, uniqueEmail(t), "Dr. Integration Phantom")
			packageID := seedPackage(t, doctorID, 3, 300000)
			patientEmail := uniqueEmail(t)
			userID := seedUser(t, patientEmail, "Patient@123", "patient")
			c := newTestClient(t, h)
			c.login(patientEmail, "Patient@123")

			rec, _, text := c.request(http.MethodPost, "/api/payments/packages/"+packageID+"/checkout", nil)
			if rec.Code != tc.wantErr {
				t.Fatalf("%s: %d %s; want %d", tc.name, rec.Code, text, tc.wantErr)
			}
			var purchases, orders int
			if err := itPool.QueryRow("SELECT COUNT(*) FROM `PackagePurchase` WHERE userId = ?", userID).Scan(&purchases); err != nil {
				t.Fatalf("count purchases: %v", err)
			}
			if err := itPool.QueryRow("SELECT COUNT(*) FROM `PaymentOrder` o LEFT JOIN `PackagePurchase` p ON p.id = o.purchaseId WHERE p.id IS NULL").Scan(&orders); err != nil {
				t.Fatalf("count orphan orders: %v", err)
			}
			if purchases != 0 || orders != 0 {
				t.Fatalf("%s: purchases=%d orphanOrders=%d; want 0/0 (no phantom rows)", tc.name, purchases, orders)
			}
			// The patient can retry: the claim was removed with the rows.
			snap.setMode("")
			rec, _, text = c.request(http.MethodPost, "/api/payments/packages/"+packageID+"/checkout", nil)
			if rec.Code != http.StatusCreated {
				t.Fatalf("retry after %s: %d %s; want 201", tc.name, rec.Code, text)
			}
		})
	}
}

func TestIntegrationLiveWebhookUnknownOrderIsQuietSuccess(t *testing.T) {
	snap := newFakeSnap(t)
	s := newMidtransIntegrationServer(t, snap.server.URL)
	h := s.Mount()

	patientEmail := uniqueEmail(t)
	seedUser(t, patientEmail, "Patient@123", "patient")
	c := newTestClient(t, h)
	c.login(patientEmail, "Patient@123")

	raw := midtransNotification("ME-UNKNOWN-1", "200", "capture", "1000.00", s.Cfg.PaymentServerKey)
	rec, body, text := c.request(http.MethodPost, "/api/payments/notification", json.RawMessage(raw))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown order webhook: %d %s; want 200", rec.Code, text)
	}
	if got := dataObject(t, body)["reason"]; got != "unknown_order" {
		t.Fatalf("unknown order reason = %v; want unknown_order", got)
	}
	var orders int
	if err := itPool.QueryRow(
		"SELECT COUNT(*) FROM `PaymentOrder` WHERE orderId = ?", "ME-UNKNOWN-1").Scan(&orders); err != nil || orders != 0 {
		t.Fatalf("rows for an unknown order = %d; want 0", orders)
	}
}
