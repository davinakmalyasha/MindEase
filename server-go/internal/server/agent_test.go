package server

import (
	"strings"
	"testing"
)

func TestAgentPreviewTruncates(t *testing.T) {
	long := ""
	for i := 0; i < 200; i++ {
		long += "a"
	}
	got := agentPreviewOf(long)
	if len([]rune(got)) != 140 {
		t.Fatalf("preview len = %d; want 140", len(got))
	}
	if got := agentPreviewOf("  hello  "); got != "hello" {
		t.Fatalf("preview trims; got %q", got)
	}
}

func TestADKInstructionHoldsSafetyRails(t *testing.T) {
	for _, rule := range []string{"Never diagnose", "NOT a doctor", "Crisis and escalation were already checked"} {
		if !strings.Contains(adkInstruction, rule) {
			t.Fatalf("adk instruction missing safety rule %q", rule)
		}
	}
}

func TestADKDoctorHitSerializes(t *testing.T) {
	hit := adkDoctorHit{ID: "d1", Name: "Dr. A", Specialty: "Clinical", Experience: 5, Price: 200000, Rating: 4.8, Link: "/doctors/d1"}
	if hit.Link != "/doctors/d1" || hit.Name == "" {
		t.Fatalf("doctor hit malformed: %#v", hit)
	}
}

func TestADKSessionHeaderDefaults(t *testing.T) {
	tr := adkHeaderTransport{}
	if tr.session != "" {
		t.Fatal("zero transport must fall back to mindease-shared at send time")
	}
}
