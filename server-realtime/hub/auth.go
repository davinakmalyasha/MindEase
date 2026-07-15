package hub

import (
	"errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims mirrors the Node API's access token payload.
type Claims struct {
	UserID int64  `json:"userId"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

var secret []byte

func init() {
	secret = []byte(os.Getenv("JWT_SECRET"))
	if len(secret) == 0 {
		secret = []byte("supersecret")
	}
}

// Authenticate verifies the shared access token and returns the user ID.
func Authenticate(tokenString string) (*Claims, error) {
	if tokenString == "" {
		return nil, errors.New("missing token")
	}

	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}

	// Reject expired tokens defensively (parser already checks exp)
	if claims.ExpiresAt != nil && claims.ExpiresAt.Before(time.Now()) {
		return nil, errors.New("token expired")
	}

	return claims, nil
}
