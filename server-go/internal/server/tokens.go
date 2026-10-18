package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	tokenIssuer    = "mindease"
	audiencePrefix = "mindease:"

	accessTTL    = 15 * time.Minute
	refreshTTL   = 7 * 24 * time.Hour
	twoFactorTTL = 5 * time.Minute

	// WsTicketTTLSeconds matches lib/tokens.ts: a ticket captured from a proxy
	// access log is worthless by the time it is read.
	WsTicketTTLSeconds = 30
)

type purpose string

const (
	purposeAccess    purpose = "access"
	purposeRefresh   purpose = "refresh"
	purposeTwoFactor purpose = "2fa-pending"
	purposeWsTicket  purpose = "ws-ticket"
)

func (s *Server) secretFor(p purpose) []byte {
	switch p {
	case purposeRefresh:
		return []byte(s.Cfg.RefreshSecret)
	case purposeTwoFactor:
		return []byte(s.Cfg.TwoFactorSecret)
	default:
		// access and ws-ticket share JWT_SECRET: the realtime service only
		// holds that one, and the distinct audience keeps them apart.
		return []byte(s.Cfg.JWTSecret)
	}
}

func (s *Server) signToken(p purpose, ttl time.Duration, claims jwt.MapClaims) (string, error) {
	now := time.Now()
	claims["purpose"] = string(p)
	claims["iss"] = tokenIssuer
	claims["aud"] = audiencePrefix + string(p)
	claims["iat"] = now.Unix()
	claims["exp"] = now.Add(ttl).Unix()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secretFor(p))
}

// verifyToken asserts purpose, issuer, audience and algorithm, so a token
// minted for one flow can never be replayed into another.
func (s *Server) verifyToken(token string, p purpose) (jwt.MapClaims, error) {
	parsed, err := jwt.Parse(token,
		func(t *jwt.Token) (any, error) { return s.secretFor(p), nil },
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer(tokenIssuer),
		jwt.WithAudience(audiencePrefix+string(p)),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(5*time.Second),
	)
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	if purposeClaim, _ := claims["purpose"].(string); purposeClaim != string(p) {
		return nil, fmt.Errorf("expected a %q token", p)
	}
	return claims, nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Server) signAccessToken(userID, role string, totpVerified bool) (string, error) {
	return s.signToken(purposeAccess, accessTTL, jwt.MapClaims{
		"userId":       userID,
		"role":         role,
		"totpVerified": totpVerified,
	})
}

func (s *Server) signRefreshToken(userID string, amr []string) (string, error) {
	if len(amr) == 0 {
		amr = []string{"pwd"}
	}
	return s.signToken(purposeRefresh, refreshTTL, jwt.MapClaims{
		"userId": userID,
		"amr":    amr,
		"jti":    newID(),
	})
}

func (s *Server) signTwoFactorToken(userID string) (string, error) {
	return s.signToken(purposeTwoFactor, twoFactorTTL, jwt.MapClaims{"userId": userID})
}

func (s *Server) signWsTicket(userID, role string) (string, error) {
	return s.signToken(purposeWsTicket, WsTicketTTLSeconds*time.Second, jwt.MapClaims{
		"userId": userID,
		"role":   role,
	})
}
