package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIFenceNeutralisesTheClosingMarker(t *testing.T) {
	marker := "journal_" + aiFenceNonce
	fenced := aiFence("journal", "hello "+marker+" world", 1000)
	if strings.Contains(fenced, marker+" world") {
		t.Fatal("patient text containing the marker closed the fence early")
	}
	if !strings.Contains(fenced, marker+"X") {
		t.Fatal("the marker inside the content was not neutralised")
	}
	if strings.Count(fenced, "<<<journal_") != 1 {
		t.Fatal("the fence opening appears more than once")
	}
}

func TestAICleanJSONStripsCodeFences(t *testing.T) {
	cases := map[string]string{
		"```json\n[\"a\"]\n```": "[\"a\"]",
		"```\n{\"a\":1}\n```":   "{\"a\":1}",
		"  [1,2]  ":             "[1,2]",
	}
	for input, want := range cases {
		if got := aiCleanJSON(input); got != want {
			t.Fatalf("aiCleanJSON(%q) = %q; want %q", input, got, want)
		}
	}
}

func TestAICompleteWithoutClientReportsNotConfigured(t *testing.T) {
	s := testServer()
	text, source, reason := s.aiComplete(context.Background(), "prompt")
	if text != "" || source != "fallback" || reason != "not_configured" {
		t.Fatalf("got (%q,%q,%q); want empty/fallback/not_configured", text, source, reason)
	}
}

func TestAIProvenanceReasonsOnlyAccompanyFallbacks(t *testing.T) {
	model := aiProvenance("model", "")
	if model["source"] != "model" {
		t.Fatalf("model provenance = %#v", model)
	}
	if _, present := model["degradedReason"]; present {
		t.Fatal("a model result must not carry a degraded reason")
	}
	fallback := aiProvenance("fallback", "timeout")
	if fallback["degradedReason"] != "timeout" {
		t.Fatalf("fallback provenance = %#v", fallback)
	}
}

func TestAIPreSessionQuestionsUsesTheModel(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"[\"Question one?\",\"Question two?\",\"Question three?\",\"Question four?\",\"Question five?\"]"}}]}`))
	}))
	defer provider.Close()

	cfg := testConfig(t)
	cfg.AIAPIKey = "test-key"
	cfg.AIBaseURL = provider.URL
	cfg.AIModel = "test-model"
	cfg.AiRequestTimeoutMs = 2000
	s := New(cfg, nil, nil, itLog)

	questions, source, reason := s.aiPreSessionQuestions(context.Background(), "Clinical Psychologist", nil)
	if source != "model" || reason != "" {
		t.Fatalf("source/reason = %q/%q; want model/empty", source, reason)
	}
	if len(questions) != 5 || questions[0] != "Question one?" {
		t.Fatalf("questions = %#v", questions)
	}
}

func TestAIPreSessionQuestionsFallsBackOnMalformedOutput(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"I cannot produce JSON today."}}]}`))
	}))
	defer provider.Close()

	cfg := testConfig(t)
	cfg.AIAPIKey = "test-key"
	cfg.AIBaseURL = provider.URL
	cfg.AIModel = "test-model"
	cfg.AiRequestTimeoutMs = 2000
	s := New(cfg, nil, nil, itLog)

	questions, source, reason := s.aiPreSessionQuestions(context.Background(), "Clinical Psychologist", nil)
	if source != "fallback" || reason != "malformed" {
		t.Fatalf("source/reason = %q/%q; want fallback/malformed", source, reason)
	}
	if len(questions) != 5 {
		t.Fatalf("fallback questions = %d; want 5", len(questions))
	}
}
