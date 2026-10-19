package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestChatParsesAnOpenAICompatibleResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("authorization = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("request body: %v", err)
		}
		if body["model"] != "deepseek/deepseek-v4.1-flash" {
			t.Errorf("model = %v", body["model"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"  Hello from the model.  "}}]}`))
	}))
	defer server.Close()

	client := New(server.URL, "test-key", "deepseek/deepseek-v4.1-flash", 5*time.Second)
	text, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "Hi"}})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if text != "Hello from the model." {
		t.Fatalf("text = %q", text)
	}
}

func TestChatReportsProviderErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"http error", http.StatusUnauthorized, `{"error":{"message":"bad key"}}`},
		{"provider error", http.StatusOK, `{"error":{"message":"quota exhausted"}}`},
		{"no choices", http.StatusOK, `{"choices":[]}`},
		{"empty content", http.StatusOK, `{"choices":[{"message":{"content":"   "}}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := New(server.URL, "test-key", "model", time.Second)
			if _, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "Hi"}}); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestChatHonoursContextDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Outlast the client, then finish: the client cancels at the context
		// deadline, while Close must not wait forever for the handler.
		time.Sleep(300 * time.Millisecond)
	}))
	defer server.Close()
	client := New(server.URL, "test-key", "model", 5*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := client.Chat(ctx, []Message{{Role: "user", Content: "Hi"}})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "context") {
		t.Fatalf("err = %v; want a context deadline", err)
	}
}
