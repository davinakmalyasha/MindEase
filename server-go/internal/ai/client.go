// Package ai is a small client for an OpenAI-compatible chat-completions
// provider. The deployment points it at Command Code's gateway and the
// DeepSeek V4.1 Flash model; nothing in the client depends on either name.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Client struct {
	BaseURL string
	APIKey  string
	Model   string
	HTTP    *http.Client
}

func New(baseURL, apiKey, model string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		Model:   model,
		HTTP:    &http.Client{Timeout: timeout},
	}
}

// Chat sends one completion request and returns the assistant's text.
//
// The response envelope is OpenAI-compatible: `choices[0].message.content`.
// Reasoning models may also return `reasoning_content`; it is deliberately not
// used as a fallback for the answer, because a thinking trace is not a reply.
func (c *Client) Chat(ctx context.Context, messages []Message) (string, error) {
	// No temperature: some reasoning models reject sampling parameters, and
	// the prompts already specify the output shape. The token budget includes
	// any reasoning the provider spends before the answer.
	payload := map[string]any{
		"model":      c.Model,
		"messages":   messages,
		"max_tokens": 1600,
		"stream":     false,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.BaseURL+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.APIKey)

	response, err := c.HTTP.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// The body is the provider's own error message; truncate it so a
		// pathological response cannot flood a log line.
		return "", fmt.Errorf("ai provider returned %d: %s", response.StatusCode, truncate(string(body), 300))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("ai provider response is not JSON: %w", err)
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return "", errors.New("ai provider: " + parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return "", errors.New("ai provider returned no choices")
	}
	text := strings.TrimSpace(parsed.Choices[0].Message.Content)
	if text == "" {
		return "", errors.New("ai provider returned empty content")
	}
	return text, nil
}

func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "..."
}
