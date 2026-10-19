package server

import (
	"context"
	"strings"
	"testing"
)

func TestMailOtpTemplate(t *testing.T) {
	for _, purpose := range []string{"reset", "verify"} {
		subject, body := mailOtpTemplate(purpose, "123456")
		if !strings.Contains(subject, "MindEase") {
			t.Fatalf("%s subject = %q; want a MindEase subject", purpose, subject)
		}
		if !strings.Contains(body, "123456") {
			t.Fatalf("%s body does not contain the code", purpose)
		}
		if purpose == "reset" && !strings.Contains(subject, "password reset") {
			t.Fatalf("reset subject = %q", subject)
		}
		if purpose == "verify" && !strings.Contains(subject, "Verify") {
			t.Fatalf("verify subject = %q", subject)
		}
	}
}

func TestMailNotificationTemplateEscapesContent(t *testing.T) {
	_, body := mailNotificationTemplate(
		`<img src=x onerror=alert(1)>`,
		`Hello <script>alert(1)</script>`,
	)
	if strings.Contains(body, "<img") || strings.Contains(body, "<script>") {
		t.Fatal("the notification template did not escape user-controlled content")
	}
	if !strings.Contains(body, "&lt;img") {
		t.Fatal("the escaped title is missing from the template")
	}
}

func TestPushIsNoopWithoutVapid(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")
	s := testServer()
	// With no VAPID keys the function must return before touching the database;
	// testServer has no pool, so a query here would panic.
	s.pushSend(context.Background(), "user-1", "Title", "Body", "/dashboard")
}
