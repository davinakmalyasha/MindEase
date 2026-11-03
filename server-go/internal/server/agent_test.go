package server

import (
	"testing"
)

func TestAgentPreviewTruncates(t *testing.T) {
	long := ""
	for i := 0; i < 200; i++ {
		long += "a"
	}
	got := agentPreviewOf(long)
	if len([]rune(got)) != 140 {
		t.Fatalf("preview len = %d; want 140", len([]rune(got)))
	}
	if got := agentPreviewOf("  hello  "); got != "hello" {
		t.Fatalf("preview trims; got %q", got)
	}
}

func TestAgentParseModelJSONAnswer(t *testing.T) {
	call, answer, ok := agentParseModelJSON(`{"answer":"Hi there"}`)
	if !ok || answer != "Hi there" || call != nil {
		t.Fatalf("answer parse = %#v %q %v", call, answer, ok)
	}
}

func TestAgentParseModelJSONTool(t *testing.T) {
	call, answer, ok := agentParseModelJSON("```json\n{\"tool\":\"search_doctors\",\"args\":{\"query\":\"anxiety\"}}\n```")
	if !ok || answer != "" || call == nil || call.Tool != "search_doctors" {
		t.Fatalf("tool parse = %#v %q %v", call, answer, ok)
	}
}

func TestAgentParseModelJSONRejectsProse(t *testing.T) {
	if _, _, ok := agentParseModelJSON("Sure, here are doctors..."); ok {
		t.Fatal("prose must not parse as tool JSON")
	}
}

func TestAgentUnknownToolFailsClosed(t *testing.T) {
	s := testServer()
	res, _, _, stop := s.agentExecTool(t.Context(), "u", &agentToolCall{Tool: "book_appointment", Args: map[string]any{}}, true)
	if res.OK || stop {
		t.Fatalf("unknown tool must fail closed: %#v", res)
	}
}
