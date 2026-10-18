package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// audit writes an AuditLog row, best-effort like AuditService.log: a failed
// audit write must not fail the request it describes.
func (s *Server) audit(ctx context.Context, action string, actorID *string, targetType *string, targetID *string, meta map[string]any) {
	var metaJSON *string
	if meta != nil {
		if raw, err := json.Marshal(meta); err == nil {
			value := string(raw)
			metaJSON = &value
		}
	}
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `AuditLog` (id, actorId, action, targetType, targetId, meta, createdAt) VALUES (?,?,?,?,?,?,?)",
		newID(), actorID, action, targetType, targetID, metaJSON, time.Now().UTC())
	if err != nil {
		s.Log.Warn("audit write failed", "action", action, "err", err)
	}
}

func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}

// scanNullString converts a sql.NullString into the pointer JSON wants.
func strPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	return &ns.String
}

func strValue(ns sql.NullString) string {
	if !ns.Valid {
		return ""
	}
	return ns.String
}
