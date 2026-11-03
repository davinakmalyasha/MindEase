package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestIntegrationAgentMemorySearchStream(t *testing.T) {
	s := newIntegrationServer(t)
	h := s.Mount()

	pID := seedUser(t, uniqueEmail(t), "Patient@123", "patient")
	dEmail := uniqueEmail(t)
	_, _ = seedDoctor(t, dEmail, "Dr. Agent Search")

	p := newTestClient(t, h)
	p.login(getEmailForUser(t, pID), "Patient@123")

	// Consent on first: memory endpoints fail closed without it.
	rec, _, text := p.request(http.MethodPost, "/api/agent/memories", map[string]any{"content": "x"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("memory without consent: %d %s; want 403", rec.Code, text)
	}

	rec, _, text = p.request(http.MethodPut, "/api/account/consents", map[string]any{"purpose": "ai-read", "granted": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("consent on: %d %s", rec.Code, text)
	}

	rec, body, text := p.request(http.MethodPost, "/api/agent/memories", map[string]any{"content": "My dog Bruno calms me down after late meetings"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("memory create: %d %s", rec.Code, text)
	}
	mid := dataMap(t, body)["id"].(string)
	if mid == "" {
		t.Fatal("memory create returned no id")
	}

	// List returns previews only, never full content.
	rec, body, text = p.request(http.MethodGet, "/api/agent/memories", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("memory list: %d %s", rec.Code, text)
	}
	rows, _ := dataMap(t, body)["memories"].([]any)
	if len(rows) != 1 {
		t.Fatalf("memory list len = %d; want 1", len(rows))
	}
	m0 := rows[0].(map[string]any)
	if _, has := m0["content"]; has {
		t.Fatal("memory list must not leak full content")
	}
	if m0["preview"] == nil || !strings.Contains(m0["preview"].(string), "Bruno") {
		t.Fatalf("memory preview missing content: %v", m0)
	}

	// Full fetch is ownership-checked and returns content.
	rec, body, text = p.request(http.MethodGet, "/api/agent/memories/"+mid, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("memory get: %d %s", rec.Code, text)
	}
	if !strings.Contains(dataMap(t, body)["content"].(string), "Bruno") {
		t.Fatalf("memory get content wrong: %v", body)
	}

	// Doctor search via chat: deterministic path still uses the real DB rows.
	rec, body, text = p.request(http.MethodPost, "/api/support/chat", map[string]any{
		"message": "Can you find me a doctor for anxiety?",
		"history": []any{},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("support chat search: %d %s", rec.Code, text)
	}
	d := dataMap(t, body)
	doctors, _ := d["doctors"].([]any)
	if len(doctors) == 0 {
		t.Fatalf("doctor search via agent returned none: %v", d)
	}
	first := doctors[0].(map[string]any)
	if first["link"] == nil || !strings.HasPrefix(first["link"].(string), "/doctors/") {
		t.Fatalf("doctor card missing deep link: %v", first)
	}

	// Crisis still short-circuits before any tool.
	rec, body, text = p.request(http.MethodPost, "/api/support/chat", map[string]any{
		"message": "I want to kill myself", "history": []any{},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("crisis chat: %d %s", rec.Code, text)
	}
	if dataMap(t, body)["crisis"] != true {
		t.Fatalf("crisis must be flagged: %v", body)
	}

	// Stream emits SSE with a terminal done event.
	rec, _, text = p.request(http.MethodPost, "/api/support/chat/stream", map[string]any{
		"message": "hello", "history": []any{},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("stream: %d %s", rec.Code, text)
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("stream content-type = %q; want SSE", ct)
	}
	if !strings.Contains(text, "event: done") {
		t.Fatalf("stream missing done event: %.200s", text)
	}

	// Delete + revoke: list degrades to empty, chat memory gated.
	rec, _, text = p.request(http.MethodDelete, "/api/agent/memories/"+mid, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("memory delete: %d %s", rec.Code, text)
	}
	rec, body, text = p.request(http.MethodPut, "/api/account/consents", map[string]any{"purpose": "ai-read", "granted": false})
	if rec.Code != http.StatusOK {
		t.Fatalf("consent off: %d %s", rec.Code, text)
	}
	rec, body, text = p.request(http.MethodGet, "/api/agent/memories", nil)
	if rec.Code != http.StatusOK || dataMap(t, body)["consent"] != false {
		t.Fatalf("memory list after revoke must report consent false: %d %s", rec.Code, text)
	}
}
