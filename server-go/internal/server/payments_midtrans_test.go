package server

import (
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"testing"
)

func midtransNotification(orderID, statusCode, transactionStatus, grossAmount, serverKey string) string {
	sum := sha512.Sum512([]byte(orderID + statusCode + grossAmount + serverKey))
	return fmt.Sprintf(
		`{"order_id":%q,"status_code":%q,"transaction_status":%q,"gross_amount":%q,"signature_key":%q,"transaction_id":"tx-1"}`,
		orderID, statusCode, transactionStatus, grossAmount, hex.EncodeToString(sum[:]))
}

func midtransServer(t *testing.T) *Server {
	t.Helper()
	s := testServer()
	s.Cfg.PaymentMode = "midtrans"
	s.Cfg.PaymentServerKey = "server-key"
	return s
}

func TestMidtransNotificationVerifiesTheStatusCodeSignature(t *testing.T) {
	s := midtransServer(t)
	raw := midtransNotification("ME-1", "200", "capture", "300000.00", s.Cfg.PaymentServerKey)
	notification, err := s.payParseNotification(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if notification.OrderID != "ME-1" || notification.Outcome != "paid" || notification.Amount != 300000 {
		t.Fatalf("notification = %#v", notification)
	}
	if notification.Reference == nil || *notification.Reference != "tx-1" {
		t.Fatalf("reference = %v", notification.Reference)
	}
}

func TestMidtransSignatureMustNotUseTransactionStatus(t *testing.T) {
	s := midtransServer(t)
	// The Node implementation (and the first Go port) composed the signature
	// with transaction_status. Midtrans signs status_code; this locks the fix.
	wrong := sha512.Sum512([]byte("ME-1" + "capture" + "300000.00" + s.Cfg.PaymentServerKey))
	raw := fmt.Sprintf(
		`{"order_id":"ME-1","status_code":"200","transaction_status":"capture","gross_amount":"300000.00","signature_key":%q}`,
		hex.EncodeToString(wrong[:]))
	if _, err := s.payParseNotification(raw); err == nil {
		t.Fatal("a signature composed with transaction_status was accepted")
	}
}

func TestMidtransOutcomeComesFromTransactionStatus(t *testing.T) {
	s := midtransServer(t)
	raw := midtransNotification("ME-2", "200", "settlement", "150000.00", s.Cfg.PaymentServerKey)
	notification, err := s.payParseNotification(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Funds are only guaranteed on capture; settlement is still refundable.
	if notification.Outcome != "pending" {
		t.Fatalf("outcome = %q; want pending", notification.Outcome)
	}
}

func TestMidtransUnknownTransactionStatusIsRejected(t *testing.T) {
	s := midtransServer(t)
	raw := midtransNotification("ME-3", "200", "teleported", "1000.00", s.Cfg.PaymentServerKey)
	if _, err := s.payParseNotification(raw); err == nil {
		t.Fatal("an unknown transaction_status was accepted")
	}
}
