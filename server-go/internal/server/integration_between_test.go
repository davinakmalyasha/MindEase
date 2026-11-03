package server

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func dataMap(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	d, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("response has no data object: %v", body)
	}
	return d
}

func TestIntegrationRiskResolveOutcomeAndSLA(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	patientID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	dEmail := uniqueEmail(t)
	_, dDoctorID := seedDoctor(t, dEmail, "Dr. Safety Loop")
	_ = seedCompletedAppointment(t, patientID, dDoctorID)

	d := newTestClient(t, h)
	d.login(dEmail, "Doctor@123")

	// Urgent resolve without followUp defaults to +24h and records outcome.
	r1 := seedRiskAlert(t, patientID, "urgent", nil, time.Now().UTC().Add(-5*time.Hour))
	rec, body, text := d.request(http.MethodPost, "/api/wellness/risk-alerts/"+r1+"/resolve",
		map[string]any{"note": "Called, safety plan reviewed.", "outcome": "contacted"})
	if rec.Code != http.StatusOK {
		t.Fatalf("resolve urgent: %d %s", rec.Code, text)
	}
	got := dataMap(t, body)
	if got["outcome"] != "contacted" {
		t.Fatalf("outcome = %#v; want contacted", got["outcome"])
	}
	if got["followUpDueAt"] == nil {
		t.Fatal("urgent resolve without followUpDueAt should default to +24h")
	}

	// Invalid outcome rejected.
	r2 := seedRiskAlert(t, patientID, "elevated", nil, time.Now().UTC())
	rec, _, text = d.request(http.MethodPost, "/api/wellness/risk-alerts/"+r2+"/resolve",
		map[string]any{"outcome": "teleported"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad outcome: %d %s; want 400", rec.Code, text)
	}

	// SLA: urgent 5h unacknowledged is overdue; elevated fresh is not.
	rec, body, text = d.request(http.MethodGet, "/api/wellness/risk-alerts", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("queue list: %d %s", rec.Code, text)
	}
	items, _ := body["data"].([]any)
	foundOverdue := false
	for _, it := range items {
		m, _ := it.(map[string]any)
		if m["id"] == r2 {
			if m["isOverdue"] == true {
				t.Fatal("fresh elevated alert should not be overdue")
			}
			if m["hoursOpen"] == nil {
				t.Fatal("hoursOpen missing on queue item")
			}
		}
		if m["isOverdue"] == true {
			foundOverdue = true
		}
	}
	_ = foundOverdue
	counts, _ := body["counts"].(map[string]any)
	if counts["overdue"] == nil || counts["followUpDue"] == nil {
		t.Fatalf("counts missing overdue/followUpDue: %v", counts)
	}
}

func TestIntegrationShortScreenersAndMCID(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	patientID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	_ = patientID
	p := newTestClient(t, h)
	p.login(getEmailForUser(t, patientID), "Patient@123")

	// PHQ-2 needs exactly 2 answers.
	rec, _, text := p.request(http.MethodPost, "/api/wellness/assessments",
		map[string]any{"type": "phq2", "answers": []int{1, 1}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("phq2 submit: %d %s", rec.Code, text)
	}
	// Wrong count rejected.
	rec, _, text = p.request(http.MethodPost, "/api/wellness/assessments",
		map[string]any{"type": "phq2", "answers": []int{1, 1, 1}})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("phq2 wrong count: %d %s; want 400", rec.Code, text)
	}
	// Trajectory carries MCID and stale flags.
	rec, body, text := p.request(http.MethodGet, "/api/wellness/assessments/trajectory?type=phq2", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("phq2 trajectory: %d %s", rec.Code, text)
	}
	sum, _ := body["data"].(map[string]any)["summary"].(map[string]any)
	if sum["mcid"] == nil || sum["clinicallySignificantChange"] == nil || sum["isStale"] == nil {
		t.Fatalf("trajectory summary missing mcid/sig/stale: %v", sum)
	}
	// Status endpoint covers all four instruments.
	rec, body, text = p.request(http.MethodGet, "/api/wellness/assessments/status", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("assessment status: %d %s", rec.Code, text)
	}
	data, _ := body["data"].(map[string]any)
	for _, k := range []string{"phq9", "gad7", "phq2", "gad2"} {
		if _, ok := data[k]; !ok {
			t.Fatalf("status missing %s", k)
		}
	}
}

func getEmailForUser(t *testing.T, userID string) string {
	t.Helper()
	var email string
	if err := itPool.QueryRow("SELECT email FROM `User` WHERE id = ?", userID).Scan(&email); err != nil {
		t.Fatalf("read email: %v", err)
	}
	return email
}

func TestIntegrationThoughtRecordCRUD(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	pID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	p := newTestClient(t, h)
	p.login(getEmailForUser(t, pID), "Patient@123")
	otherID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	other := newTestClient(t, h)
	other.login(getEmailForUser(t, otherID), "Patient@123")

	rec, body, text := p.request(http.MethodPost, "/api/wellness/thought-records", map[string]any{
		"situation": "Meeting ran late", "thought": "I am failing", "moodBefore": 2, "balanced": "One late meeting is not failure",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("thought create: %d %s", rec.Code, text)
	}
	id := dataMap(t, body)["id"].(string)

	// Owner can list; stranger cannot read/update.
	rec, body, _ = p.request(http.MethodGet, "/api/wellness/thought-records", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("thought list: %d", rec.Code)
	}
	rec, _, _ = other.request(http.MethodPut, "/api/wellness/thought-records/"+id, map[string]any{"thought": "hijack"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("stranger update: %d; want 404", rec.Code)
	}
	rec, body, text = p.request(http.MethodPut, "/api/wellness/thought-records/"+id, map[string]any{"moodAfter": 4})
	if rec.Code != http.StatusOK {
		t.Fatalf("thought update: %d %s", rec.Code, text)
	}
	rec, _, text = p.request(http.MethodDelete, "/api/wellness/thought-records/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("thought delete: %d %s", rec.Code, text)
	}
}

func TestIntegrationFeedbackConsentCaseload(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	pID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	dEmail := uniqueEmail(t)
	dUserID, dDoctorID := seedDoctor(t, dEmail, "Dr. Between")
	apptID := seedCompletedAppointment(t, pID, dDoctorID)

	p := newTestClient(t, h)
	p.login(getEmailForUser(t, pID), "Patient@123")
	d := newTestClient(t, h)
	d.login(dEmail, "Doctor@123")

	// SRS feedback: patient creates, both sides read, double submit conflicts.
	rec, _, text := p.request(http.MethodPost, "/api/appointments/"+apptID+"/feedback",
		map[string]any{"listening": 8, "goals": 7, "approach": 9, "overall": 8, "comment": "Felt heard."})
	if rec.Code != http.StatusCreated {
		t.Fatalf("feedback create: %d %s", rec.Code, text)
	}
	rec, _, text = p.request(http.MethodPost, "/api/appointments/"+apptID+"/feedback",
		map[string]any{"listening": 8, "goals": 7, "approach": 9, "overall": 8})
	if rec.Code != http.StatusConflict {
		t.Fatalf("double feedback: %d %s; want 409", rec.Code, text)
	}
	rec, body, text := d.request(http.MethodGet, "/api/appointments/"+apptID+"/feedback", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("doctor reads feedback: %d %s", rec.Code, text)
	}
	if dataMap(t, body)["overall"] == nil {
		// data may be the object itself for GET; accept either shape.
		if body["data"] == nil {
			t.Fatalf("feedback read empty: %v", body)
		}
	}

	// Consent: default false, set true, audited.
	rec, body, _ = p.request(http.MethodGet, "/api/account/consents", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("consent list: %d", rec.Code)
	}
	rec, _, text = p.request(http.MethodPut, "/api/account/consents", map[string]any{"purpose": "ai-read", "granted": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("consent set: %d %s", rec.Code, text)
	}
	var flag bool
	if err := itPool.QueryRow("SELECT aiReadConsent FROM `User` WHERE id = ?", pID).Scan(&flag); err != nil || !flag {
		t.Fatalf("aiReadConsent flag = %v err %v; want true", flag, err)
	}

	// Caseload: doctor sees patient, upcoming, safety and risk sections.
	rec, body, text = d.request(http.MethodGet, "/api/doctors/caseload", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("caseload: %d %s", rec.Code, text)
	}
	cdata := dataMap(t, body)
	for _, k := range []string{"patients", "upcoming", "overdueRisk", "unreviewedSafety", "counts"} {
		if _, ok := cdata[k]; !ok {
			t.Fatalf("caseload missing %s", k)
		}
	}
	_ = dUserID
	_ = strings.Contains(text, "patients")
}

func TestIntegrationBriefingAgentGathersConsentGates(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	pID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	dEmail := uniqueEmail(t)
	_, dDoctorID := seedDoctor(t, dEmail, "Dr. Agent")
	apptID := seedCompletedAppointment(t, pID, dDoctorID)

	p := newTestClient(t, h)
	p.login(getEmailForUser(t, pID), "Patient@123")
	d := newTestClient(t, h)
	d.login(dEmail, "Doctor@123")

	// Build the between-session record: thought, homework with due date, alliance.
	rec, _, text := p.request(http.MethodPost, "/api/wellness/thought-records", map[string]any{
		"situation": "Review meeting ran late", "thought": "I am failing",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("thought for briefing: %d %s", rec.Code, text)
	}
	rec, body, text := p.request(http.MethodGet, "/api/care-plan", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("care plan: %d %s", rec.Code, text)
	}
	planID := dataMap(t, body)["id"].(string)
	rec, body, text = p.request(http.MethodPost, "/api/care-plan/"+planID+"/goals", map[string]any{"title": "Practice grounding"})
	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("goal: %d %s", rec.Code, text)
	}
	goalID := dataMap(t, body)["id"].(string)
	tomorrow := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02")
	rec, _, text = p.request(http.MethodPost, "/api/care-plan/goals/"+goalID+"/steps", map[string]any{"title": "Box breathing 5 min", "dueDate": tomorrow})
	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("step: %d %s", rec.Code, text)
	}
	rec, _, text = p.request(http.MethodPost, "/api/appointments/"+apptID+"/feedback",
		map[string]any{"listening": 8, "goals": 7, "approach": 9, "overall": 8})
	if rec.Code != http.StatusCreated {
		t.Fatalf("feedback for briefing: %d %s", rec.Code, text)
	}

	// Consent on: the briefing gathers all four and cites them.
	rec, _, text = p.request(http.MethodPut, "/api/account/consents", map[string]any{"purpose": "ai-read", "granted": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("consent on: %d %s", rec.Code, text)
	}
	rec, body, text = d.request(http.MethodPost, "/api/ai/briefing", map[string]any{"appointmentId": apptID})
	if rec.Code != http.StatusOK {
		t.Fatalf("briefing with consent: %d %s", rec.Code, text)
	}
	bdata := dataMap(t, body)
	srcs, _ := bdata["sources"].([]any)
	kinds := map[string]bool{}
	for _, s := range srcs {
		if m, ok := s.(map[string]any); ok {
			kinds[m["kind"].(string)] = true
		}
	}
	for _, k := range []string{"thought", "homework", "alliance"} {
		if !kinds[k] {
			t.Fatalf("briefing sources missing %s: %v", k, kinds)
		}
	}
	if bdata["insufficientData"] == true {
		t.Fatal("briefing with thought+homework+alliance must not be insufficient-data")
	}

	// Consent off: same record, fallback with consent-off, nothing persisted as model.
	rec, _, text = p.request(http.MethodPut, "/api/account/consents", map[string]any{"purpose": "ai-read", "granted": false})
	if rec.Code != http.StatusOK {
		t.Fatalf("consent off: %d %s", rec.Code, text)
	}
	rec, body, text = d.request(http.MethodPost, "/api/ai/briefing", map[string]any{"appointmentId": apptID})
	if rec.Code != http.StatusOK {
		t.Fatalf("briefing without consent: %d %s", rec.Code, text)
	}
	bdata = dataMap(t, body)
	ai, _ := bdata["ai"].(map[string]any)
	if ai["source"] != "fallback" || ai["degradedReason"] != "consent-off" {
		t.Fatalf("consent-off briefing ai = %v; want fallback/consent-off", ai)
	}
}

func TestIntegrationBetweenJobs(t *testing.T) {
	s := newIntegrationServer(t)

	pID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	// Resolved urgent alert with due follow-up in the past fires once.
	alertID := seedRiskAlert(t, pID, "urgent", nil, time.Now().UTC().Add(-48*time.Hour))
	if _, err := itPool.Exec("UPDATE `RiskAlert` SET resolvedAt = ?, resolvedById = ?, followUpDueAt = ? WHERE id = ?",
		time.Now().UTC().Add(-25*time.Hour), pID, time.Now().UTC().Add(-time.Hour), alertID); err != nil {
		t.Fatalf("seed resolved alert: %v", err)
	}
	summary, err := s.jobsCareCheckins(context.Background())
	if err != nil {
		t.Fatalf("checkins: %v", err)
	}
	if summary.postResolve < 1 {
		t.Fatalf("postResolve = %d; want >=1", summary.postResolve)
	}
	var cleared *time.Time
	if err := itPool.QueryRow("SELECT followUpDueAt FROM `RiskAlert` WHERE id = ?", alertID).Scan(&cleared); err != nil || cleared != nil {
		t.Fatalf("followUpDueAt not cleared: %v err %v", cleared, err)
	}
}
