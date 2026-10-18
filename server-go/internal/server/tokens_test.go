package server

import (
	"testing"

	"github.com/davinakmalyasha/MindEase/server-go/internal/config"
)

func testServer() *Server {
	return &Server{Cfg: &config.Config{
		JWTSecret:       "test-jwt-secret-0123456789",
		RefreshSecret:   "test-refresh-secret-0123456789",
		TwoFactorSecret: "test-2fa-secret-0123456789",
	}}
}

func TestAccessTokenRoundTrip(t *testing.T) {
	s := testServer()
	token, err := s.signAccessToken("user-1", "doctor", true)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	claims, err := s.verifyToken(token, purposeAccess)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims["userId"] != "user-1" || claims["role"] != "doctor" || claims["totpVerified"] != true {
		t.Fatalf("claims not preserved: %#v", claims)
	}
}

func TestTokenPurposesCannotCross(t *testing.T) {
	s := testServer()
	refresh, err := s.signRefreshToken("user-1", []string{"pwd"})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := s.verifyToken(refresh, purposeAccess); err == nil {
		t.Fatal("a refresh token must not verify as an access token")
	}

	pending, err := s.signTwoFactorToken("user-1")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := s.verifyToken(pending, purposeAccess); err == nil {
		t.Fatal("a pending 2FA ticket must not verify as an access token")
	}
	if _, err := s.verifyToken(pending, purposeTwoFactor); err != nil {
		t.Fatalf("pending ticket should verify for its own purpose: %v", err)
	}

	ticket, err := s.signWsTicket("user-1", "patient")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := s.verifyToken(ticket, purposeWsTicket); err != nil {
		t.Fatalf("ws ticket should verify for its own purpose: %v", err)
	}
	if _, err := s.verifyToken(ticket, purposeAccess); err == nil {
		t.Fatal("a ws ticket must not verify as an access token despite sharing the secret")
	}
}

func TestHashTokenIsSHA256Hex(t *testing.T) {
	got := hashToken("abc")
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Fatalf("hashToken = %s, want %s", got, want)
	}
}
