package server

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/davinakmalyasha/MindEase/server-go/internal/ai"
)

// Agent memory + read-only directory reads.
//
// Long-term memory is per account, preview-first: the list endpoint returns
// only previews so full content is never injected into a prompt unless the
// agent explicitly fetches one note. Consent (ai-read) gates memory tools,
// and every tool call is audited. The ADK agent in agent_adk.go owns the
// model loop; this file owns storage and the deterministic no-key fallback.

// agentMemory is one long-term row. List surfaces preview only; Get surfaces
// the full content after an ownership check.
type agentMemory struct {
	ID        string
	Preview   string
	Content   string
	CreatedAt time.Time
}

func agentPreviewOf(content string) string {
	trimmed := strings.TrimSpace(content)
	runes := []rune(trimmed)
	if len(runes) > 140 {
		return string(runes[:140])
	}
	return trimmed
}

// agentMemoryList returns previews newest-first, capped. Failures degrade to
// no context, never to an error: memory must not break chat.
func (s *Server) agentMemoryList(ctx context.Context, userID string, limit int) []agentMemory {
	if limit <= 0 || limit > 10 {
		limit = 3
	}
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, preview, createdAt FROM `AiMemory` WHERE userId = ? ORDER BY createdAt DESC LIMIT ?",
		userID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []agentMemory{}
	for rows.Next() {
		var m agentMemory
		if err := rows.Scan(&m.ID, &m.Preview, &m.CreatedAt); err != nil {
			continue
		}
		out = append(out, m)
	}
	return out
}

func (s *Server) agentMemoryGet(ctx context.Context, userID, id string) (*agentMemory, error) {
	var m agentMemory
	var content string
	err := s.DB.QueryRowContext(ctx,
		"SELECT id, preview, content, createdAt FROM `AiMemory` WHERE id = ? AND userId = ?",
		id, userID).Scan(&m.ID, &m.Preview, &content, &m.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.Content = content
	return &m, nil
}

func (s *Server) agentMemoryCreate(ctx context.Context, userID, content string) (*agentMemory, error) {
	clean := strings.TrimSpace(s.wellnessSanitize(content))
	if clean == "" {
		return nil, BadRequest("Content is required")
	}
	if len([]rune(clean)) > 2000 {
		return nil, BadRequest("Content too long")
	}
	now := time.Now().UTC()
	m := &agentMemory{ID: newID(), Preview: agentPreviewOf(clean), Content: clean, CreatedAt: now}
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `AiMemory` (id, userId, preview, content, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
		m.ID, userID, m.Preview, m.Content, now, now); err != nil {
		return nil, err
	}
	actor := userID
	target := "AiMemory"
	s.audit(ctx, "memory.created", &actor, &target, &m.ID, map[string]any{"previewLen": len([]rune(m.Preview))})
	return m, nil
}

func (s *Server) agentMemoryDelete(ctx context.Context, userID, id string) error {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM `AiMemory` WHERE id = ? AND userId = ?", id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return NotFound("Memory not found")
	}
	actor := userID
	target := "AiMemory"
	s.audit(ctx, "memory.deleted", &actor, &target, &id, map[string]any{})
	return nil
}

func (s *Server) agentHasConsent(ctx context.Context, userID string) bool {
	var flag bool
	_ = s.DB.QueryRowContext(ctx, "SELECT aiReadConsent FROM `User` WHERE id = ?", userID).Scan(&flag)
	return flag
}

type agentToolResult struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Summary string `json:"summary"`
	// Doctors carries structured directory hits for the UI card renderer.
	// It is never free text from the model, only rows the DB returned.
	Doctors []map[string]any `json:"doctors,omitempty"`
}

// agentSearchDoctors is the read-only directory query behind the tool. It
// reuses the fallback criteria path so results are identical with or without
// a model: the model only chooses the filters, never the rows.
func (s *Server) agentSearchDoctors(ctx context.Context, criteria aiMatchCriteria) []map[string]any {
	sqlText := "SELECT d.id, d.specialty, d.experience, d.price, d.rating, u.name " +
		"FROM `Doctor` d JOIN `User` u ON u.id = d.userId " +
		"WHERE d.verificationStatus = 'approved'"
	args := []any{}
	if criteria.Specialty != nil && strings.TrimSpace(*criteria.Specialty) != "" {
		sqlText += " AND d.specialty LIKE ?"
		args = append(args, "%"+strings.TrimSpace(*criteria.Specialty)+"%")
	}
	if criteria.MaxPrice != nil {
		sqlText += " AND d.price <= ?"
		args = append(args, int(*criteria.MaxPrice))
	}
	sqlText += " ORDER BY d.rating DESC LIMIT 5"
	rows, err := s.DB.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, specialty string
		var exp, price int
		var rating float64
		var name sql.NullString
		if err := rows.Scan(&id, &specialty, &exp, &price, &rating, &name); err != nil {
			continue
		}
		label := "Doctor"
		if name.Valid && name.String != "" {
			label = name.String
		}
		out = append(out, map[string]any{
			"id": labelID(id), "name": label, "specialty": specialty,
			"experience": exp, "price": price, "rating": rating,
			"link": "/doctors/" + id,
		})
	}
	return out
}

func labelID(id string) string { return id }

// agentToneContext is the read-only tone signal: mood average + latest
// screening. Failures degrade to empty, never to an error.
func (s *Server) agentToneContext(ctx context.Context, userID string) (string, string) {
	moodAvg := ""
	if rows, err := s.DB.QueryContext(ctx, "SELECT mood FROM `MoodEntry` WHERE userId = ? ORDER BY createdAt DESC LIMIT 7", userID); err == nil {
		total, n := 0, 0
		for rows.Next() {
			var m int
			if err := rows.Scan(&m); err == nil {
				total += m
				n++
			}
		}
		rows.Close()
		if n > 0 {
			moodAvg = aiToFixed1(float64(total) / float64(n))
		}
	}
	latest := ""
	var t string
	var score int
	var sev string
	if err := s.DB.QueryRowContext(ctx, "SELECT type, score, severity FROM `Assessment` WHERE userId = ? ORDER BY createdAt DESC LIMIT 1", userID).Scan(&t, &score, &sev); err == nil {
		latest = strings.ToUpper(t) + " " + fmt.Sprint(score) + " (" + sev + ")"
	}
	return moodAvg, latest
}

// agentDeterministic is the no-model path: keyword tools + canned reply.
// It guarantees the agent endpoints are useful and testable with no key, and
// is the degraded branch when the ADK run fails (expired key, budget spent).
func (s *Server) agentDeterministic(ctx context.Context, userID, clean string, _ []ai.Message, appointmentContext string, consent bool) (string, string, []agentToolResult, []map[string]any, bool) {
	tools := []agentToolResult{}
	doctors := []map[string]any{}
	memUsed := false
	lowered := strings.ToLower(clean)

	// Remember requests are explicit only: "remember ..." saves the rest.
	if consent && (strings.HasPrefix(lowered, "remember ") || strings.HasPrefix(lowered, "ingat ")) {
		content := strings.TrimSpace(clean[len(strings.Split(clean, " ")[0])+1:])
		if content != "" {
			if m, err := s.agentMemoryCreate(ctx, userID, content); err == nil {
				tools = append(tools, agentToolResult{Name: "memory_note", OK: true, Summary: "saved note [" + m.ID + "]"})
				return "Got it — I'll remember that for next time.", "fallback", tools, nil, true
			}
		}
	}

	// Doctor search intent without clicking filters.
	if strings.Contains(lowered, "doctor") || strings.Contains(lowered, "dokter") || strings.Contains(lowered, "psikolog") ||
		strings.Contains(lowered, "book") || strings.Contains(lowered, "cari") || strings.Contains(lowered, "recommend") || strings.Contains(lowered, "specialist") {
		criteria := aiFallbackMatchCriteria(clean)
		doctors = s.agentSearchDoctors(ctx, criteria)
		tools = append(tools, agentToolResult{Name: "search_doctors", OK: true, Summary: fmt.Sprintf("%d match(es)", len(doctors)), Doctors: doctors})
		if len(doctors) > 0 {
			names := make([]string, 0, len(doctors))
			for _, d := range doctors {
				names = append(names, fmt.Sprintf("%s (%s)", d["name"], d["specialty"]))
			}
			reply := "I found " + fmt.Sprint(len(doctors)) + " approved psychologists: " + strings.Join(names, ", ") + ". Open their cards below to book — booking stays one tap away."
			if strings.TrimSpace(appointmentContext) != "" {
				reply += " " + appointmentContext
			}
			return reply, "fallback", tools, doctors, memUsed
		}
	}

	// Memory recall intent.
	if consent && (strings.Contains(lowered, "remember") || strings.Contains(lowered, "ingat") || strings.Contains(lowered, "note")) {
		previews := s.agentMemoryList(ctx, userID, 3)
		tools = append(tools, agentToolResult{Name: "memory_search", OK: true, Summary: fmt.Sprintf("%d saved note(s)", len(previews))})
		if len(previews) == 0 {
			return "You have no saved notes yet. Say \"remember ...\" and I'll keep it here for next time.", "fallback", tools, nil, false
		}
		lines := make([]string, 0, len(previews))
		for _, m := range previews {
			lines = append(lines, m.Preview)
		}
		return "Here's what I have saved: " + strings.Join(lines, " · "), "fallback", tools, nil, true
	}

	// Default: canned help topics, exactly as before.
	answer := supportDefaultReply
	for _, candidate := range supportFallbackAnswers {
		if candidate.pattern.MatchString(clean) {
			answer = candidate.answer
			break
		}
	}
	return answer + supportFallbackDisclosure, "fallback", tools, nil, false
}
