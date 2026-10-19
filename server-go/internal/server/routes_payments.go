package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha512"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-sql-driver/mysql"
	"github.com/microcosm-cc/bluemonday"
)

// registerPayments ports routes/payment.routes.ts and services/payment.service.ts.
//
// The provider callback is mounted before `authenticate`, exactly where the
// Node router mounts it. Its CSRF exemption lives with the other global
// exemptions (csrf.go), and the general per-IP limiter is mounted on the whole
// /api router in server.go the way app.ts mounts it - the Node route file
// declares no limiter of its own, so neither does this one.
func (s *Server) registerPayments(api chi.Router) {
	api.Post("/payments/notification", s.handlePaymentNotification)

	api.Group(func(r chi.Router) {
		r.Use(s.authenticate)
		r.Get("/payments/config", s.handlePaymentConfig)
		r.Get("/payments/purchases", s.handlePaymentPurchases)
		r.With(s.payValidateIDParam).Get("/payments/purchases/{id}", s.handlePaymentPurchaseStatus)
		r.With(s.payValidateIDParam).Post("/payments/packages/{id}/checkout", s.handlePaymentCheckout)
	})
}

const (
	payModeMidtrans  = "midtrans"
	payModeSimulator = "simulator"

	payOutcomePaid    = "paid"
	payOutcomePending = "pending"
	payOutcomeFailed  = "failed"
	payOutcomeExpired = "expired"
)

// payProviderMode is getPaymentProvider()'s selection: `midtrans` only when
// config.Load saw PAYMENT_PROVIDER=midtrans plus PAYMENT_SERVER_KEY, so a
// deployment configured for real money can never resolve to the simulator
// (config.Load carries the same production guards as config/env.ts).
func (s *Server) payProviderMode() string {
	if s.Cfg.PaymentMode == payModeMidtrans {
		return payModeMidtrans
	}
	return payModeSimulator
}

var payUUID7Pattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// payValidateIDParam ports validate(idParam) for the shared UUIDv7 `:id`
// param, with the zod middleware's exact failure envelope.
func (s *Server) payValidateIDParam(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !payUUID7Pattern.MatchString(chi.URLParam(r, "id")) {
			s.validationFail(w, "params.id", "Invalid id")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// -------------------- GET /payments/config --------------------

// handlePaymentConfig tells the client which provider is live so a checkout
// can be labelled as a simulation rather than implying a real card charge.
// The response is exactly the controller's `{ mode, simulated }`; there is no
// clientKey field in the Node contract, and the Midtrans client key is
// deliberately not published by this endpoint.
func (s *Server) handlePaymentConfig(w http.ResponseWriter, _ *http.Request) {
	mode := s.payProviderMode()
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data": map[string]any{
			"mode":      mode,
			"simulated": mode != payModeMidtrans,
		},
	})
}

// -------------------- POST /payments/packages/:id/checkout --------------------

func (s *Server) handlePaymentCheckout(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	session, err := s.payCreateCheckout(r.Context(), chi.URLParam(r, "id"), user.ID)
	if err != nil {
		s.payRespondError(w, r, err, http.StatusBadRequest, "Could not start checkout.")
		return
	}
	s.JSON(w, http.StatusCreated, map[string]any{"status": "success", "data": session})
}

type payCheckoutLine struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Price    int64  `json:"price"`
	Quantity int    `json:"quantity"`
}

// payCreateCheckout ports PaymentService.createCheckout end to end: the
// package and clinician checks, the atomic liveKey claim, the durable
// PaymentOrder mapping, the provider call, immediate simulator settlement,
// and the phantom-row cleanup when the provider call fails.
func (s *Server) payCreateCheckout(ctx context.Context, pkgID, userID string) (map[string]any, error) {
	mode := s.payProviderMode()
	simulated := mode != payModeMidtrans

	var (
		pkgTotalPrice   int64
		pkgSessionCount int64
		verification    string
		doctorName      sql.NullString
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT p.totalPrice, p.sessionCount, d.verificationStatus, u.name "+
			"FROM `Package` p JOIN `Doctor` d ON d.id = p.doctorId JOIN `User` u ON u.id = d.userId "+
			"WHERE p.id = ? AND p.active = TRUE", pkgID).
		Scan(&pkgTotalPrice, &pkgSessionCount, &verification, &doctorName)
	if err == sql.ErrNoRows {
		return nil, NotFound("Package not found or inactive")
	}
	if err != nil {
		return nil, err
	}
	if verification != "approved" {
		return nil, BadRequest("This package is not currently available")
	}
	doctorDisplayName := "your psychologist"
	if doctorName.Valid {
		doctorDisplayName = doctorName.String
	}

	var (
		userName  sql.NullString
		userEmail string
	)
	err = s.DB.QueryRowContext(ctx, "SELECT name, email FROM `User` WHERE id = ?", userID).
		Scan(&userName, &userEmail)
	if err == sql.ErrNoRows {
		return nil, NotFound("User not found")
	}
	if err != nil {
		return nil, err
	}
	customerName := "Patient"
	if userName.Valid {
		customerName = userName.String
	}

	// One live checkout per (user, package), enforced by the unique liveKey.
	// This used to be read-before-create, so two concurrent requests both read
	// "none" and both created a pending purchase - and once both settled the
	// patient held two entitlements. The claim is `userId:packageId` while the
	// purchase is pending and unpaid; it is cleared on settlement and the row
	// disappears on failure. A single nullable column rather than a partial
	// unique index because MySQL has no partial unique index.
	liveKey := userID + ":" + pkgID
	orderID := payNewOrderID()
	purchaseID := newID()
	now := time.Now().UTC()

	_, err = s.DB.ExecContext(ctx,
		"INSERT INTO `PackagePurchase` (id, packageId, userId, sessionsLeft, status, paidAt, grantedByUserId, totalPrice, sessionCount, reference, liveKey, createdAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		purchaseID, pkgID, userID, 0, "pending", nil, nil, pkgTotalPrice, pkgSessionCount, nil, liveKey, now)
	if err != nil {
		// The database is the arbiter: a concurrent create loses on the unique
		// index and gets the same 409 the old pre-check returned (Prisma's
		// P2002 in Node, MySQL error 1062 here).
		if payIsDuplicateKey(err) {
			return nil, Conflict("You already have a pending purchase for this package")
		}
		return nil, err
	}

	// The provider is told the order id before the redirect and sends it back
	// on the callback, so the mapping is persisted first; a callback that
	// arrives immediately still resolves.
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `PaymentOrder` (id, orderId, purchaseId, amount, currency, status, reference, simulated, createdAt, settledAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?)",
		newID(), orderID, purchaseID, pkgTotalPrice, "IDR", "pending", nil, simulated, now, nil); err != nil {
		return nil, err
	}

	successURL := s.Cfg.FrontendURL + "/dashboard/profile?purchase=" + purchaseID

	// A failed checkout is not an entitlement and not revenue: remove both
	// rows so the patient does not see a phantom package and the clinic does
	// not report a sale that never started. Errors are swallowed, as in Node.
	cleanup := func() {
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.DB.ExecContext(cctx, "DELETE FROM `PaymentOrder` WHERE purchaseId = ?", purchaseID)
		_, _ = s.DB.ExecContext(cctx, "DELETE FROM `PackagePurchase` WHERE id = ?", purchaseID)
	}

	checkoutURL := ""
	if simulated {
		// A deterministic, obviously-fake URL. There is no upstream to receive
		// the redirect, so settlement is applied immediately below instead of
		// pretending a round trip happened.
		sep := "?"
		if strings.Contains(successURL, "?") {
			sep = "&"
		}
		checkoutURL = successURL + sep + "sim=1&order=" + url.QueryEscape(orderID)
	} else {
		lineName := fmt.Sprintf("%d-session package with %s", pkgSessionCount, doctorDisplayName)
		checkoutURL, err = s.payMidtransCreateCheckout(ctx, orderID, pkgTotalPrice, []payCheckoutLine{{
			ID:       pkgID,
			Name:     lineName,
			Price:    pkgTotalPrice,
			Quantity: 1,
		}}, customerName, userEmail, successURL)
		if err != nil {
			cleanup()
			return nil, err
		}
	}

	if simulated {
		// The purchase is otherwise indistinguishable from a real one: same
		// row, same `paidAt`, same entitlement.
		if _, err := s.payApplyOutcome(ctx, orderID, float64(pkgTotalPrice), payOutcomePaid, ptr("sim_"+orderID)); err != nil {
			cleanup()
			return nil, err
		}
	}

	return map[string]any{
		"checkoutUrl": checkoutURL,
		"orderId":     orderID,
		"purchaseId":  purchaseID,
		"simulated":   simulated,
	}, nil
}

// payMidtransCreateCheckout posts the Snap transaction exactly as
// lib/payments.ts does: Basic auth over `serverKey:`, the same body, and the
// same two failure conditions (non-2xx, or a session missing token/redirect).
func (s *Server) payMidtransCreateCheckout(ctx context.Context, orderID string, amount int64, lines []payCheckoutLine, customerName, customerEmail, successURL string) (string, error) {
	body := map[string]any{
		"transaction_details": map[string]any{
			"order_id":     orderID,
			"gross_amount": amount,
		},
		"item_details": lines,
		"customer_details": map[string]any{
			"first_name": customerName,
			"email":      customerEmail,
		},
		"custom_expiry": map[string]any{"unit": "hour", "expiry_duration": 24},
		"callbacks":     map[string]any{"finish": successURL},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.Cfg.PaymentBaseURL+"/snap/v1/transactions", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(s.Cfg.PaymentServerKey+":")))

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("payment provider rejected the checkout (%d): %s", resp.StatusCode, string(detail))
	}

	var payload struct {
		Token       string `json:"token"`
		RedirectURL string `json:"redirect_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.RedirectURL == "" || payload.Token == "" {
		return "", errors.New("payment provider returned an incomplete checkout session")
	}
	return payload.RedirectURL, nil
}

// -------------------- POST /payments/notification --------------------

func (s *Server) handlePaymentNotification(w http.ResponseWriter, r *http.Request) {
	// The signature covers the exact bytes the provider sent, so the raw body
	// is read before any decode. The global bodyLimit middleware only caps the
	// reader; it does not consume the body.
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		s.payRejectNotification(w, r, err)
		return
	}
	result, err := s.payHandleNotification(r.Context(), string(raw))
	if err != nil {
		s.payRejectNotification(w, r, err)
		return
	}
	// Always 200 on a well-formed notification, even a duplicate: providers
	// retry non-2xx aggressively and a retry storm on a settled order is noise.
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": result})
}

// payRejectNotification is the controller's catch block: log the reason,
// answer the provider's signature/amount failures with 400.
func (s *Server) payRejectNotification(w http.ResponseWriter, r *http.Request, err error) {
	s.Log.Warn("rejected payment notification", "err", err.Error(), "requestId", RequestID(r))
	s.Fail(w, http.StatusBadRequest, "Invalid payment notification")
}

type payNotification struct {
	OrderID   string
	Outcome   string
	Amount    float64
	Reference *string
}

func (s *Server) payHandleNotification(ctx context.Context, raw string) (payOutcomeResult, error) {
	notification, err := s.payParseNotification(raw)
	if err != nil {
		return payOutcomeResult{}, err
	}
	return s.payApplyOutcome(ctx, notification.OrderID, notification.Amount, notification.Outcome, notification.Reference)
}

func (s *Server) payParseNotification(raw string) (*payNotification, error) {
	if s.payProviderMode() == payModeMidtrans {
		return s.payParseMidtransNotification(raw)
	}
	return s.payParseSimulatedNotification(raw)
}

// payMidtransOutcomes collapses Midtrans status codes onto the four outcomes.
// `settlement` is pending, not paid: funds are only guaranteed on `capture`,
// and granting an entitlement on a still-refundable authorisation is how a
// clinic serves sessions it was never paid for.
var payMidtransOutcomes = map[string]string{
	"settlement":     payOutcomePending,
	"capture":        payOutcomePaid,
	"pending":        payOutcomePending,
	"deny":           payOutcomeFailed,
	"cancel":         payOutcomeFailed,
	"expire":         payOutcomeExpired,
	"failure":        payOutcomeFailed,
	"refund":         payOutcomeExpired,
	"partial-refund": payOutcomePending,
	"reversal":       payOutcomeFailed,
}

// payVerifyMidtransSignature is sha512(orderId+statusCode+grossAmount+serverKey)
// compared timing-safely: `==` on hex digests leaks how many leading characters
// matched. This is the single thing standing between a forged POST and a free
// therapy package.
func payVerifyMidtransSignature(orderID, statusCode, grossAmount, signature, serverKey string) bool {
	sum := sha512.Sum512([]byte(orderID + statusCode + grossAmount + serverKey))
	expected := hex.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) == 1
}

func (s *Server) payParseMidtransNotification(raw string) (*payNotification, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, errors.New("malformed payment notification")
	}
	orderID, _ := payload["order_id"].(string)
	statusCode, _ := payload["transaction_status"].(string)
	grossAmount, _ := payload["gross_amount"].(string)
	signature, _ := payload["signature_key"].(string)
	if orderID == "" || statusCode == "" || grossAmount == "" || signature == "" {
		return nil, errors.New("payment notification is missing required fields")
	}
	if !payVerifyMidtransSignature(orderID, statusCode, grossAmount, signature, s.Cfg.PaymentServerKey) {
		return nil, errors.New("payment notification signature is invalid")
	}
	outcome, ok := payMidtransOutcomes[statusCode]
	if !ok {
		return nil, fmt.Errorf("unknown payment transaction status %q", statusCode)
	}
	// A non-numeric gross amount becomes NaN and then fails the amount check
	// in applyOutcome, exactly like Number() + Math.round() in Node.
	amount, err := strconv.ParseFloat(strings.TrimSpace(grossAmount), 64)
	if err != nil {
		amount = math.NaN()
	}
	var reference *string
	if v, ok := payload["transaction_id"].(string); ok {
		reference = &v
	}
	return &payNotification{
		OrderID:   orderID,
		Outcome:   outcome,
		Amount:    math.Round(amount),
		Reference: reference,
	}, nil
}

// payParseSimulatedNotification has no signature to check: the simulator is
// in-process, and in a real deployment it cannot be selected at all.
func (s *Server) payParseSimulatedNotification(raw string) (*payNotification, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, errors.New("malformed simulated payment notification")
	}
	orderID, _ := payload["orderId"].(string)
	if orderID == "" {
		return nil, errors.New("simulated payment notification is missing required fields")
	}
	amountRaw, present := payload["amount"]
	if !present || payJSONAmountMissing(amountRaw) {
		return nil, errors.New("simulated payment notification is missing required fields")
	}
	outcome := payOutcomePaid
	if outcomeRaw, ok := payload["outcome"]; ok && outcomeRaw != nil {
		value, ok := outcomeRaw.(string)
		if !ok || !payIsKnownOutcome(value) {
			return nil, fmt.Errorf("unknown simulated outcome %v", outcomeRaw)
		}
		outcome = value
	}
	reference := "sim_" + orderID
	return &payNotification{
		OrderID:   orderID,
		Outcome:   outcome,
		Amount:    math.Round(payNumberFromJSON(amountRaw)),
		Reference: &reference,
	}, nil
}

func payIsKnownOutcome(value string) bool {
	switch value {
	case payOutcomePaid, payOutcomePending, payOutcomeFailed, payOutcomeExpired:
		return true
	}
	return false
}

// payJSONAmountMissing mirrors `!payload.amount` truthiness: absent, null,
// zero, an empty string and false are missing; anything else proceeds (and a
// non-numeric value becomes NaN, which the amount check later rejects).
func payJSONAmountMissing(v any) bool {
	switch n := v.(type) {
	case nil:
		return true
	case float64:
		return n == 0
	case string:
		return strings.TrimSpace(n) == ""
	case bool:
		return !n
	}
	return false
}

// payNumberFromJSON mirrors Number(value) + Math.round: numbers pass through,
// numeric strings parse, anything else is NaN and fails the amount check.
func payNumberFromJSON(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case bool:
		if n {
			return 1
		}
		return 0
	}
	return math.NaN()
}

// -------------------- outcome application --------------------

type payOutcomeResult struct {
	Applied    bool   `json:"applied"`
	Reason     string `json:"reason"`
	PurchaseID string `json:"purchaseId,omitempty"`
}

type payPurchaseRow struct {
	ID           string
	UserID       string
	SessionsLeft int64
	Status       string
	PaidAt       sql.NullTime
	TotalPrice   int64
	SessionCount int64
	Reference    sql.NullString
}

// payApplyOutcome ports PaymentService.applyOutcome: idempotent and monotonic.
// `paidAt` is only ever written here, from a verified callback, and the
// purchase row is the authority on what was sold while the provider is the
// authority on the amount.
func (s *Server) payApplyOutcome(ctx context.Context, orderID string, amount float64, outcome string, reference *string) (payOutcomeResult, error) {
	var (
		purchase    payPurchaseRow
		orderAmount int64
		hasOrder    bool
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT pp.id, pp.userId, pp.sessionsLeft, pp.status, pp.paidAt, pp.totalPrice, pp.sessionCount, pp.reference, po.amount "+
			"FROM `PaymentOrder` po JOIN `PackagePurchase` pp ON pp.id = po.purchaseId "+
			"WHERE po.orderId = ?", orderID).
		Scan(&purchase.ID, &purchase.UserID, &purchase.SessionsLeft, &purchase.Status, &purchase.PaidAt,
			&purchase.TotalPrice, &purchase.SessionCount, &purchase.Reference, &orderAmount)
	switch {
	case err == nil:
		hasOrder = true
	case err == sql.ErrNoRows:
		// Orders that predate the PaymentOrder mapping resolve through the
		// `reference` fallback the index on PackagePurchase exists for.
		err = s.DB.QueryRowContext(ctx,
			"SELECT id, userId, sessionsLeft, status, paidAt, totalPrice, sessionCount, reference "+
				"FROM `PackagePurchase` WHERE `reference` = ? LIMIT 1", orderID).
			Scan(&purchase.ID, &purchase.UserID, &purchase.SessionsLeft, &purchase.Status, &purchase.PaidAt,
				&purchase.TotalPrice, &purchase.SessionCount, &purchase.Reference)
		if err == sql.ErrNoRows {
			s.Log.Warn("payment callback for an unknown order", "orderId", orderID)
			return payOutcomeResult{Applied: false, Reason: "unknown_order"}, nil
		}
		if err != nil {
			return payOutcomeResult{}, err
		}
	default:
		return payOutcomeResult{}, err
	}

	if purchase.PaidAt.Valid {
		// Already settled. A repeat callback is not an error, but it must not
		// grant a second set of sessions.
		return payOutcomeResult{Applied: false, Reason: "already_paid"}, nil
	}

	if outcome != payOutcomePaid {
		if outcome == payOutcomePending {
			// Recording the status lets a reconciliation job tell
			// "authorised, not captured" from "unknown".
			if hasOrder {
				if _, uerr := s.DB.ExecContext(ctx,
					"UPDATE `PaymentOrder` SET `status` = ? WHERE orderId = ?", payOutcomePending, orderID); uerr != nil {
					s.Log.Warn("payment order pending update failed", "orderId", orderID, "err", uerr)
				}
			}
			return payOutcomeResult{Applied: false, Reason: "still_pending"}, nil
		}
		// Failed or expired: release both rows entirely so they do not sit in
		// the patient's package list or the revenue figures. The status update
		// before the delete mirrors the service's order of operations.
		if hasOrder {
			_, _ = s.DB.ExecContext(ctx, "UPDATE `PaymentOrder` SET `status` = ? WHERE orderId = ?", outcome, orderID)
			_, _ = s.DB.ExecContext(ctx, "DELETE FROM `PaymentOrder` WHERE orderId = ?", orderID)
		}
		_, _ = s.DB.ExecContext(ctx, "DELETE FROM `PackagePurchase` WHERE id = ?", purchase.ID)
		return payOutcomeResult{Applied: true, Reason: "released"}, nil
	}

	// The provider is the authority on the amount, but the order is the
	// authority on what was sold: re-checking means a tampered callback cannot
	// under-report a purchase and still be accepted.
	expected := purchase.TotalPrice
	if hasOrder {
		expected = orderAmount
	}
	if math.IsNaN(amount) || int64(math.Round(amount)) != expected {
		s.Log.Error("payment amount mismatch; refusing to grant an entitlement",
			"orderId", orderID, "expected", expected, "received", amount)
		return payOutcomeResult{}, BadRequest("Payment amount does not match the order")
	}

	var referenceArg any
	if reference != nil {
		referenceArg = *reference
	}
	now := time.Now().UTC()

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return payOutcomeResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	// One transaction, as Prisma's $transaction: grant the sessions and
	// release the checkout claim (liveKey = NULL) so the patient may buy the
	// same package again later; the unique key exists only to stop two *live*
	// orders at once.
	if _, err := tx.ExecContext(ctx,
		"UPDATE `PackagePurchase` SET paidAt = ?, `status` = 'active', sessionsLeft = ?, `reference` = ?, liveKey = NULL WHERE id = ?",
		now, purchase.SessionCount, referenceArg, purchase.ID); err != nil {
		return payOutcomeResult{}, err
	}
	if hasOrder {
		if _, err := tx.ExecContext(ctx,
			"UPDATE `PaymentOrder` SET `status` = 'paid', settledAt = ?, `reference` = ? WHERE orderId = ?",
			now, referenceArg, orderID); err != nil {
			return payOutcomeResult{}, err
		}
	} else {
		if _, err := tx.ExecContext(ctx, "DELETE FROM `PaymentOrder` WHERE orderId = ?", orderID); err != nil {
			return payOutcomeResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return payOutcomeResult{}, err
	}

	s.payCreateNotification(ctx, purchase.UserID, "Your sessions are ready",
		fmt.Sprintf("Your %d-session package has been confirmed. You can now book with your psychologist.", purchase.SessionCount),
		"appointment", true)

	return payOutcomeResult{Applied: true, Reason: "settled", PurchaseID: purchase.ID}, nil
}

// -------------------- GET /payments/purchases --------------------

type payDoctorUser struct {
	Name   *string `json:"name"`
	Avatar *string `json:"avatar"`
}

type payDoctorSummary struct {
	ID        string        `json:"id"`
	Specialty string        `json:"specialty"`
	Rating    float64       `json:"rating"`
	Price     int64         `json:"price"`
	User      payDoctorUser `json:"user"`
}

type payPackageSummary struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	Description  *string          `json:"description"`
	SessionCount int64            `json:"sessionCount"`
	TotalPrice   int64            `json:"totalPrice"`
	Doctor       payDoctorSummary `json:"doctor"`
}

// payPurchaseJSON carries the full PackagePurchase scalar set Prisma returns
// from findMany plus the explicit package/doctor allowlist the service uses
// (never a bare `include: { doctor: true }`, which leaked bank details).
type payPurchaseJSON struct {
	ID              string            `json:"id"`
	PackageID       string            `json:"packageId"`
	UserID          string            `json:"userId"`
	SessionsLeft    int64             `json:"sessionsLeft"`
	Status          string            `json:"status"`
	PaidAt          *JSTime           `json:"paidAt"`
	GrantedByUserID *string           `json:"grantedByUserId"`
	TotalPrice      int64             `json:"totalPrice"`
	SessionCount    int64             `json:"sessionCount"`
	Reference       *string           `json:"reference"`
	LiveKey         *string           `json:"liveKey"`
	CreatedAt       JSTime            `json:"createdAt"`
	Package         payPackageSummary `json:"package"`
}

func (s *Server) handlePaymentPurchases(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	purchases, err := s.payListPurchases(r.Context(), user.ID)
	if err != nil {
		s.payRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch packages.")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": purchases})
}

// payListPurchases hides rows that never settled: a `pending` row is an
// abandoned checkout, not something the patient owns.
func (s *Server) payListPurchases(ctx context.Context, userID string) ([]payPurchaseJSON, error) {
	rows, err := s.DB.QueryContext(ctx,
		"SELECT pp.id, pp.packageId, pp.userId, pp.sessionsLeft, pp.status, pp.paidAt, pp.grantedByUserId, "+
			"pp.totalPrice, pp.sessionCount, pp.reference, pp.liveKey, pp.createdAt, "+
			"pk.id, pk.name, pk.description, pk.sessionCount, pk.totalPrice, "+
			"d.id, d.specialty, d.rating, d.price, u.name, u.avatar "+
			"FROM `PackagePurchase` pp "+
			"JOIN `Package` pk ON pk.id = pp.packageId "+
			"JOIN `Doctor` d ON d.id = pk.doctorId "+
			"JOIN `User` u ON u.id = d.userId "+
			"WHERE pp.userId = ? AND pp.sessionsLeft > 0 ORDER BY pp.createdAt DESC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	purchases := []payPurchaseJSON{}
	for rows.Next() {
		var (
			purchase    payPurchaseJSON
			paidAt      sql.NullTime
			grantedBy   sql.NullString
			reference   sql.NullString
			liveKey     sql.NullString
			description sql.NullString
			doctorName  sql.NullString
			avatar      sql.NullString
		)
		if err := rows.Scan(
			&purchase.ID, &purchase.PackageID, &purchase.UserID, &purchase.SessionsLeft, &purchase.Status, &paidAt, &grantedBy,
			&purchase.TotalPrice, &purchase.SessionCount, &reference, &liveKey, &purchase.CreatedAt,
			&purchase.Package.ID, &purchase.Package.Name, &description, &purchase.Package.SessionCount, &purchase.Package.TotalPrice,
			&purchase.Package.Doctor.ID, &purchase.Package.Doctor.Specialty, &purchase.Package.Doctor.Rating, &purchase.Package.Doctor.Price,
			&doctorName, &avatar,
		); err != nil {
			return nil, err
		}
		if paidAt.Valid {
			purchase.PaidAt = jsTime(&paidAt.Time)
		}
		purchase.GrantedByUserID = payNullString(grantedBy)
		purchase.Reference = payNullString(reference)
		purchase.LiveKey = payNullString(liveKey)
		purchase.Package.Description = payNullString(description)
		purchase.Package.Doctor.User.Name = payNullString(doctorName)
		purchase.Package.Doctor.User.Avatar = payNullString(avatar)
		purchases = append(purchases, purchase)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return purchases, nil
}

// -------------------- GET /payments/purchases/:id --------------------

type payPurchaseStatusJSON struct {
	ID           string  `json:"id"`
	Status       string  `json:"status"`
	SessionsLeft int64   `json:"sessionsLeft"`
	SessionCount int64   `json:"sessionCount"`
	TotalPrice   int64   `json:"totalPrice"`
	PaidAt       *JSTime `json:"paidAt"`
	Doctor       string  `json:"doctor"`
}

func (s *Server) handlePaymentPurchaseStatus(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	status, err := s.payPurchaseStatus(r.Context(), chi.URLParam(r, "id"), user.ID)
	if err != nil {
		s.payRespondError(w, r, err, http.StatusInternalServerError, "Failed to fetch purchase.")
		return
	}
	if status == nil {
		// 404 rather than 403: a patient should not be able to probe for the
		// existence of other patients' purchases.
		s.Fail(w, http.StatusNotFound, "Purchase not found")
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": status})
}

func (s *Server) payPurchaseStatus(ctx context.Context, purchaseID, userID string) (*payPurchaseStatusJSON, error) {
	var (
		status     payPurchaseStatusJSON
		stored     string
		paidAt     sql.NullTime
		doctorName sql.NullString
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT pp.id, pp.status, pp.paidAt, pp.sessionsLeft, pp.sessionCount, pp.totalPrice, u.name "+
			"FROM `PackagePurchase` pp "+
			"JOIN `Package` pk ON pk.id = pp.packageId "+
			"JOIN `Doctor` d ON d.id = pk.doctorId "+
			"JOIN `User` u ON u.id = d.userId "+
			"WHERE pp.id = ? AND pp.userId = ? LIMIT 1", purchaseID, userID).
		Scan(&status.ID, &stored, &paidAt, &status.SessionsLeft, &status.SessionCount, &status.TotalPrice, &doctorName)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// `paid` is derived from `paidAt` rather than the stored status, so a
	// settled purchase reads paid even before any status transition lands.
	status.Status = stored
	if paidAt.Valid {
		status.Status = "paid"
		status.PaidAt = jsTime(&paidAt.Time)
	}
	status.Doctor = "your psychologist"
	if doctorName.Valid {
		status.Doctor = doctorName.String
	}
	return &status, nil
}

// -------------------- shared helpers --------------------

// payRespondError mirrors the controllers' catch blocks: typed AppErrors keep
// their status and message; anything else becomes the per-endpoint fallback
// the Node controller uses when publicMessageFor returns null.
func (s *Server) payRespondError(w http.ResponseWriter, r *http.Request, err error, fallbackStatus int, fallbackMessage string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		s.Fail(w, appErr.Status, appErr.Message)
		return
	}
	s.Log.Error("payments handler error", "err", err, "path", r.URL.Path, "requestId", RequestID(r))
	s.Fail(w, fallbackStatus, fallbackMessage)
}

func payIsDuplicateKey(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

// payNewOrderID is `ME-` plus eight random bytes as uppercase hex, the id
// shape the provider echoes back on the callback.
func payNewOrderID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "ME-" + strings.ToUpper(strings.ReplaceAll(newID(), "-", ""))[:16]
	}
	return "ME-" + strings.ToUpper(hex.EncodeToString(buf))
}

func payNullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	value := v.String
	return &value
}

// -------------------- notification row + realtime --------------------

const payRealtimeChannel = "mindease:events"

type payRealtimeEvent struct {
	UserID  string `json:"userId"`
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// payPublish ports publishEvent for the notification row this domain writes:
// fire-and-forget, silent without Redis, skipped under NODE_ENV=test.
func (s *Server) payPublish(userID, eventType string, payload any) {
	if s.Cfg.IsTest || s.Redis == nil {
		return
	}
	raw, err := json.Marshal(payRealtimeEvent{UserID: userID, Type: eventType, Payload: payload})
	if err != nil {
		s.Log.Warn("failed to encode realtime event", "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Redis.Publish(ctx, payRealtimeChannel, raw).Err(); err != nil {
		s.Log.Warn("failed to publish realtime event", "err", err)
	}
}

type payChannelPrefs struct {
	InApp bool
	Email bool
}

func payDefaultPrefs() map[string]payChannelPrefs {
	return map[string]payChannelPrefs{
		"appointment": {InApp: true, Email: false},
		"message":     {InApp: true, Email: false},
		"system":      {InApp: true, Email: true},
	}
}

// payParsePrefs ports NotificationService.parsePrefs: per-type merge over the
// defaults, with the legacy `{ type: boolean }` shape meaning inApp only.
func payParsePrefs(raw sql.NullString) map[string]payChannelPrefs {
	prefs := payDefaultPrefs()
	if !raw.Valid || raw.String == "" {
		return prefs
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw.String), &parsed); err != nil {
		return prefs
	}
	for name, value := range parsed {
		channel, known := prefs[name]
		if !known {
			continue
		}
		switch v := value.(type) {
		case bool:
			channel.InApp = v
		case map[string]any:
			channel.InApp = v["inApp"] != false
			channel.Email = v["email"] == true
		}
		prefs[name] = channel
	}
	return prefs
}

// payCreateNotification ports NotificationService.create: the per-type
// preference gate, the email copy when the category allows it, the sanitisation
// choke point, the row insert, the realtime event and web push.
func (s *Server) payCreateNotification(ctx context.Context, userID, title, message, notifType string, wantsEmail bool) {
	if notifType == "" {
		notifType = "system"
	}
	prefs := payDefaultPrefs()
	if _, known := prefs[notifType]; known {
		var raw, email sql.NullString
		err := s.DB.QueryRowContext(ctx, "SELECT notificationPrefs, email FROM `User` WHERE id = ?", userID).
			Scan(&raw, &email)
		if err != nil && err != sql.ErrNoRows {
			s.Log.Warn("payment notification preference read failed", "err", err)
			return
		}
		prefs = payParsePrefs(raw)
		channel := prefs[notifType]
		// Channels are independent: turning off in-app must not also silence
		// an email the user explicitly enabled.
		if !channel.InApp && !(wantsEmail && channel.Email) {
			return
		}
		if wantsEmail && channel.Email && email.Valid && email.String != "" {
			recipient := email.String
			subject, html := mailNotificationTemplate(title, message)
			go func() {
				sendCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := s.mailSend(sendCtx, recipient, subject, html); err != nil {
					s.Log.Warn("payment notification email failed", "userId", userID, "err", err)
				}
			}()
		}
	}
	if !prefs[notifType].InApp {
		// Email-only: the in-app row is suppressed.
		return
	}

	title = s.paySanitize(title)
	message = s.paySanitize(message)
	now := time.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `Notification` (id, userId, title, message, isRead, type, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), userID, title, message, false, notifType, now); err != nil {
		s.Log.Warn("payment notification insert failed", "err", err)
		return
	}
	s.payPublish(userID, "notification:new", map[string]any{
		"title":     title,
		"message":   message,
		"type":      notifType,
		"createdAt": nowISO(),
	})
	s.pushSend(ctx, userID, title, message, "/dashboard")
}

// payStripTagsPolicy is the second pass of utils/sanitize.ts: the port's UGC
// policy allows formatting tags, but Node's sanitize() is configured with
// `allowedTags: []`, so every tag is removed and only the text survives.
var payStripTagsPolicy = bluemonday.StripTagsPolicy()

func (s *Server) paySanitize(input string) string {
	cleaned := s.Sanitizer.Sanitize(strings.TrimSpace(input))
	cleaned = payStripTagsPolicy.Sanitize(cleaned)
	return payTruncateUTF16(cleaned, 4000)
}

func payTruncateUTF16(value string, max int) string {
	units := 0
	for i, r := range value {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > max {
			return value[:i]
		}
		units += size
	}
	return value
}
