package server

import (
	"fmt"
	"html"
)

// mailOtpTemplate ports MailerService.buildOtpEmail. The code is digits today,
// but it is escaped with the rest of the substitutions rather than trusted.
func mailOtpTemplate(purpose, otp string) (subject, body string) {
	isReset := purpose == "reset"
	subject = "Verify your MindEase email"
	bodyText := "Confirm your email address with this code — it expires in 10 minutes."
	footer := "If you didn't create a MindEase account, you can safely ignore this email."
	if isReset {
		subject = "Your MindEase password reset code"
		bodyText = "We received a request to reset your password. Use the code below — it expires in 10 minutes."
		footer = "If you didn't request this, you can safely ignore this email."
	}
	body = fmt.Sprintf(`
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2 style="color:#4f46e5">MindEase</h2>
  <p>%s</p>
  <div style="font-size:28px;font-weight:bold;letter-spacing:8px;padding:16px;background:#eef2ff;border-radius:8px;text-align:center">%s</div>
  <p style="color:#64748b;font-size:13px">%s</p>
</div>`, mailEsc(bodyText), mailEsc(otp), mailEsc(footer))
	return subject, body
}

func mailEsc(v string) string { return html.EscapeString(v) }
