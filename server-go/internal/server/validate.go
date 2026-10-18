package server

import (
	"net/http"
	"regexp"
	"strings"
	"unicode"
)

// Field validators mirroring the Zod messages the client displays, so a
// validation failure reads the same after the port.

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func emailError(email string) string {
	if !emailPattern.MatchString(email) || len(email) > 254 {
		return "Invalid email address"
	}
	return ""
}

func passwordError(password string) string {
	if len(password) < 8 {
		return "Password must be at least 8 characters"
	}
	if len(password) > 200 {
		return "Password must be at most 200 characters"
	}
	var upper, digit, special bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsDigit(r):
			digit = true
		case !unicode.IsLetter(r) && !unicode.IsDigit(r):
			special = true
		}
	}
	if !upper {
		return "Password must contain at least one uppercase letter"
	}
	if !digit {
		return "Password must contain at least one number"
	}
	if !special {
		return "Password must contain at least one special character"
	}
	return ""
}

func requiredLen(value string, max int, tooShort, tooLong string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return tooShort
	}
	if len(trimmed) > max {
		return tooLong
	}
	return ""
}

func digits6(value string) bool {
	if len(value) != 6 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// validationFail mirrors the zod validate middleware's 400 envelope.
func (s *Server) validationFail(w http.ResponseWriter, path, message string) {
	s.JSON(w, http.StatusBadRequest, map[string]any{
		"status":  "error",
		"message": message,
		"errors":  []map[string]string{{"path": path, "message": message}},
	})
}
