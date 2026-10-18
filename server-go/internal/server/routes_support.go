package server

// Port of server/src/routes/support.routes.ts, controllers/support.controller.ts
// and services/support.service.ts. The chat's AI branch is not ported: with no
// Gemini client in this binary the reply is always the Node fallback branch
// (`source: "fallback"`), and the crisis/escalation rules run first, unchanged.

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

func (s *Server) registerSupport(api chi.Router) {
	supportRate := s.limiter(rateLimitConfig{
		name:    "support",
		window:  10 * time.Minute,
		max:     60,
		message: "Too many chat messages, please slow down",
	})
	sosRate := s.supportSOSLimiter()

	api.With(s.authenticate, supportRate).Post("/support/chat", s.handleSupportChat)
	api.With(s.authenticate, sosRate).Post("/support/sos", s.handleSupportSOS)
}

const supportCrisisReply = "You matter, and I want to make sure you're safe right now. If you're in immediate danger, please call emergency services now — in Indonesia dial 112 or 119. Free, confidential help is available 24/7:\n\n" +
	"• Kemenkes SEJIWA crisis line: **119 ext 8**\n" +
	"• Halo Kemenkes: **1500-567**\n" +
	"• Into The Light Indonesia (WhatsApp): **+62 812-123-2012**\n\n" +
	"Please don't face this alone — reach out to a hotline or someone you trust, and book a session with a licensed psychologist when you're ready. You can see all hotlines here: https://mindease.app/crisis"

const supportEscalationReply = "Of course — our support team is happy to help you personally. Reach customer service here:\n\n" +
	"• Email: **support@mindease.id** (replies within 1 business day)\n" +
	"• WhatsApp: **+62 812 3456 7890**\n" +
	"• Contact page: https://mindease.app/contact\n\n" +
	"Is there anything I can help with in the meantime?"

const supportFallbackDisclosure = "\n\n_(This is a standard reply selected from our help topics rather than a live answer — if you'd prefer a person, email support@mindease.id and we'll reply within one business day.)_"

const supportDefaultReply = "Thanks for reaching out! I can help with booking sessions, pricing, mood tracking, privacy, and more."

var supportFallbackAnswers = []struct {
	pattern *regexp.Regexp
	answer  string
}{
	{
		regexp.MustCompile(`(?i)(book|booking|jadwal|reserv|session|konsultasi|buat.*janji|janji temu)`),
		"To book a session: open the doctor directory, choose a psychologist, pick an available date and time slot, fill in a short form about your situation, and confirm. The doctor will approve or reschedule your request. You can start at /appointments.",
	},
	{
		regexp.MustCompile(`(?i)(price|cost|harga|fee|biaya|bayar|tarif)`),
		"Each psychologist sets their own consultation price, shown on their profile — there are no hidden platform fees. You'll see the price before confirming your booking.",
	},
	{
		regexp.MustCompile(`(?i)(refund|cancel|cancell|batal|reschedule|ubah jadwal|jadwal ulang)`),
		`You can cancel or reschedule pending and confirmed appointments from "My Appointments" in your dashboard. Rescheduled sessions return to pending for your doctor to re-confirm.`,
	},
	{
		regexp.MustCompile(`(?i)(mood|suasana hati|wellness|tracker|log)`),
		"The mood tracker lets you log how you feel on a 1–5 scale daily. MindEase computes your 30-day average, logging streak, and emotional trend, and can suggest personalized wellness activities.",
	},
	{
		regexp.MustCompile(`(?i)(reflection|pre-session|persiapan|briefing)`),
		"Once your booking is confirmed, AI generates a few compassionate questions to help you reflect before the session. Your answers are private and only shared with your assigned psychologist to help them prepare.",
	},
	{
		regexp.MustCompile(`(?i)(privacy|private|data|pribadi|confidential|aman)`),
		"Your data is encrypted in transit (HTTPS) and access to your health records is restricted to you and your assigned psychologist. We never sell personal data. Deleting your account purges your journals, mood logs, screening results, messages, safety plan and care plan. Your appointment history and any risk disclosure are retained in anonymised form so your psychologist's clinical record stays intact. You can export everything first. Full details on the privacy page: /privacy.",
	},
	{
		regexp.MustCompile(`(?i)(verify|verified|license|izin|str|sip|tersertifikasi)`),
		"Every psychologist submits their licence number and issuing body, and our team reviews their profile before it appears in the directory. Approved profiles show a verified badge, and each doctor's licence, speciality and experience are listed on their profile page.",
	},
	{
		regexp.MustCompile(`(?i)(doctor|psychologist|psikolog|spesialis|join|menjadi dokter)`),
		"Patients can find licensed psychologists by specialty, price, and experience in the directory. Psychologists can register from the sign-up page — profiles are reviewed by our team before going live.",
	},
}

func supportMessageField(body map[string]any) (string, string) {
	v, exists := body["message"]
	if !exists {
		return "", "Invalid input: expected string, received undefined"
	}
	if v == nil {
		return "", "Invalid input: expected string, received null"
	}
	s, ok := v.(string)
	if !ok {
		return "", "Invalid input: expected string, received " + wellnessJSONType(v)
	}
	if wellnessJSLen(s) < 1 {
		return "", "Message is required"
	}
	if wellnessJSLen(s) > 2000 {
		return "", "Message too long"
	}
	return s, ""
}

func supportHistoryField(body map[string]any) (string, string) {
	v, exists := body["history"]
	if !exists {
		return "", ""
	}
	if v == nil {
		return "Invalid input: expected array, received null", "body.history"
	}
	arr, ok := v.([]any)
	if !ok {
		return "Invalid input: expected array, received " + wellnessJSONType(v), "body.history"
	}
	for i, el := range arr {
		obj, ok := el.(map[string]any)
		if !ok {
			return "Invalid input: expected object, received " + wellnessJSONType(el), fmt.Sprintf("body.history.%d", i)
		}
		role, ok := obj["role"].(string)
		if !ok || (role != "user" && role != "assistant") {
			return `Invalid option: expected one of "user"|"assistant"`, fmt.Sprintf("body.history.%d.role", i)
		}
		contentPath := fmt.Sprintf("body.history.%d.content", i)
		contentValue, exists := obj["content"]
		if !exists {
			return "Invalid input: expected string, received undefined", contentPath
		}
		if contentValue == nil {
			return "Invalid input: expected string, received null", contentPath
		}
		content, ok := contentValue.(string)
		if !ok {
			return "Invalid input: expected string, received " + wellnessJSONType(contentValue), contentPath
		}
		if wellnessJSLen(content) > 2000 {
			return "Too big: expected string to have <=2000 characters", contentPath
		}
	}
	if len(arr) > 20 {
		return "Too big: expected array to have <=20 items", "body.history"
	}
	return "", ""
}

// supportChatReply mirrors SupportService.chat with the AI branch degraded to
// the fixed knowledge base: crisis first, then escalation, then canned answer.
func (s *Server) supportChatReply(message string) (reply string, crisis bool, escalated bool, source string) {
	clean := s.wellnessSanitize(message)

	if clinicalDetectFreeTextRisk(clean) != nil {
		return supportCrisisReply, true, false, "fallback"
	}
	if clinicalEscalationPattern.MatchString(clean) {
		return supportEscalationReply, false, true, "fallback"
	}

	answer := supportDefaultReply
	for _, candidate := range supportFallbackAnswers {
		if candidate.pattern.MatchString(clean) {
			answer = candidate.answer
			break
		}
	}
	return answer + supportFallbackDisclosure, false, false, "fallback"
}

func (s *Server) handleSupportChat(w http.ResponseWriter, r *http.Request) {
	body, _, decodeErr := wellnessObjectBody(r)
	if decodeErr != "" {
		s.validationFail(w, "body", decodeErr)
		return
	}
	message, msg := supportMessageField(body)
	if msg != "" {
		s.validationFail(w, "body.message", msg)
		return
	}
	if msg, path := supportHistoryField(body); msg != "" {
		s.validationFail(w, path, msg)
		return
	}

	reply, crisis, escalated, source := s.supportChatReply(message)
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"reply":     reply,
		"crisis":    crisis,
		"escalated": escalated,
		"source":    source,
	}})
}

// supportSOSLimiter is the port of the SOS limiter in support.routes.ts: the
// bound is a safety ceiling, and a throttled press still returns the hotlines
// with a machine-readable code.
func (s *Server) supportSOSLimiter() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.Cfg.IsTest {
				next.ServeHTTP(w, r)
				return
			}
			key := "ip:" + remoteIP(r, s.Cfg.IsProd)
			count, reset := s.bump("sos", key, time.Hour, 1)
			w.Header().Set("RateLimit-Limit", "20")
			w.Header().Set("RateLimit-Remaining", strconv.Itoa(max(0, 20-count)))
			w.Header().Set("RateLimit-Reset", strconv.Itoa(reset))
			if count > 20 {
				s.FailExtra(w, http.StatusTooManyRequests,
					"We have already been alerted for you recently. If this is an emergency, please call a hotline now.",
					map[string]any{
						"code": "SOS_THROTTLED",
						"data": map[string]any{
							"doctorAlerted": false,
							"hotlines":      clinicalCrisisHotlines,
							"crisisPage":    "/crisis",
						},
					})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// supportCrisisPayload mirrors the controller's crisisPayload helper: every SOS
// response path carries the hotlines.
func supportCrisisPayload(extra map[string]any) map[string]any {
	payload := map[string]any{
		"doctorAlerted": false,
		"doctorName":    nil,
		"hotlines":      clinicalCrisisHotlines,
		"crisisPage":    "/crisis",
	}
	for k, v := range extra {
		payload[k] = v
	}
	return payload
}

func (s *Server) handleSupportSOS(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	if user.Role != "patient" {
		s.Fail(w, http.StatusForbidden, "Only patients can trigger SOS")
		return
	}
	ctx := r.Context()

	var (
		doctorUserID string
		doctorName   *string
	)
	appointmentErr := s.DB.QueryRowContext(ctx,
		"SELECT d.userId, u.name FROM `Appointment` ap "+
			"JOIN `Doctor` d ON d.id = ap.doctorId JOIN `User` u ON u.id = d.userId "+
			"WHERE ap.userId = ? AND ap.status IN ('confirmed','completed') "+
			"ORDER BY ap.appointmentDate DESC LIMIT 1",
		user.ID).Scan(&doctorUserID, &doctorName)

	if appointmentErr != nil {
		s.audit(ctx, "sos.triggered", &user.ID, nil, nil, map[string]any{
			"doctorAlerted": false,
			"reason":        "no_assigned_doctor",
		})
		s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": supportCrisisPayload(map[string]any{
			"doctorAlerted":   false,
			"reachedCareTeam": false,
			"message":         "We could not reach a care team because you have no active therapist. Please call one of the numbers below now.",
		})})
		return
	}

	patientName := "a patient"
	if user.Name != nil && *user.Name != "" {
		patientName = *user.Name
	}
	alertText := fmt.Sprintf("Your patient (%s) pressed the SOS button and needs support. Please check in with them.", patientName)

	// The SOS is raised as a RiskAlert first so it appears in the triage queue;
	// a failure to record must not suppress the paging below.
	sosAlertID := ""
	{
		candidate := newID()
		_, err := s.DB.ExecContext(ctx,
			"INSERT INTO `RiskAlert` (id, userId, level, reason, sourceType, assignedDoctorUserId, createdAt) VALUES (?,?,?,?,?,?,?)",
			candidate, user.ID, "urgent", "Patient pressed the SOS button and requested immediate support.",
			"sos", doctorUserID, time.Now().UTC())
		if err != nil {
			s.Log.Error("failed to record SOS as a risk alert", "err", err, "userId", user.ID)
		} else {
			sosAlertID = candidate
		}
	}

	deliveredInApp := false
	if err := s.wellnessNotifyCreate(ctx, doctorUserID, "SOS Alert from a patient", alertText, "system", true); err != nil {
		s.Log.Error("SOS in-app notification failed", "err", err, "doctorUserId", doctorUserID)
	} else {
		deliveredInApp = true
	}

	// Realtime is fire-and-forget and deliberately excluded from `doctorAlerted`.
	s.wellnessPublishEvent(ctx, doctorUserID, "sos:alert", map[string]any{
		"patientName": patientName,
		"patientId":   user.ID,
	})

	var doctorPhone *string
	var doctorEmail string
	if err := s.DB.QueryRowContext(ctx,
		"SELECT phone_number, email FROM `User` WHERE id = ?", doctorUserID).Scan(&doctorPhone, &doctorEmail); err != nil {
		doctorPhone = nil
		doctorEmail = ""
	}

	deliveredWhatsApp := false
	if doctorPhone != nil && *doctorPhone != "" {
		if s.wellnessWhatsAppSend(ctx, *doctorPhone, "SOS: "+alertText) {
			deliveredWhatsApp = true
		}
	}

	deliveredEmail := false
	if doctorEmail != "" {
		subject, html := wellnessBuildNotificationEmail("SOS Alert from a patient", alertText)
		if err := s.wellnessMailerSend(ctx, doctorEmail, subject, html); err != nil {
			s.Log.Error("SOS email alert failed", "err", err)
		} else {
			deliveredEmail = true
		}
	}

	doctorAlerted := deliveredInApp || deliveredWhatsApp || deliveredEmail
	recorded := sosAlertID != ""
	delivered := map[string]any{
		"inApp":    deliveredInApp,
		"realtime": true,
		"whatsapp": deliveredWhatsApp,
		"email":    deliveredEmail,
	}
	if !doctorAlerted || !recorded {
		s.Log.Error("SOS could not confirm delivery to a clinician",
			"userId", user.ID, "doctorUserId", doctorUserID, "delivered", delivered, "recorded", recorded)
	}

	targetID := doctorUserID
	if sosAlertID != "" {
		targetID = sosAlertID
	}
	s.audit(ctx, "sos.triggered", &user.ID, ptr("RiskAlert"), &targetID, map[string]any{
		"doctorAlerted": doctorAlerted,
		"recorded":      recorded,
		"delivered":     delivered,
	})

	doctorDisplayName := "your therapist"
	if doctorName != nil && *doctorName != "" {
		doctorDisplayName = *doctorName
	}
	message := "We could not reach your care team just now. Please call one of the numbers below, or contact your therapist directly - they can see this in their queue when the connection recovers."
	if doctorAlerted {
		message = fmt.Sprintf("We have alerted %s. If you are in immediate danger, please call one of the numbers below now.", doctorDisplayName)
	}

	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": supportCrisisPayload(map[string]any{
		"doctorAlerted":   doctorAlerted,
		"doctorName":      doctorName,
		"reachedCareTeam": doctorAlerted,
		"recorded":        recorded,
		"message":         message,
	})})
}
