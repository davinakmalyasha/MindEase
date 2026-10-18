package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// registerRealtime ports routes/realtime.routes.ts. The ticket is what a
// browser can actually deliver to the WebSocket service: it cannot set
// headers on a handshake, and the accessToken cookie is host-only for the API
// origin. Reaching this route requires a valid, database-checked session, so a
// banned user or a session missing its second factor cannot mint one.
func (s *Server) registerRealtime(api chi.Router) {
	api.With(s.authenticate).Post("/realtime/ticket", s.handleRealtimeTicket)
}

func (s *Server) handleRealtimeTicket(w http.ResponseWriter, r *http.Request) {
	user := CurrentUser(r)
	if user == nil {
		s.Fail(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	ticket, err := s.signWsTicket(user.ID, user.Role)
	if err != nil {
		s.AppErr(w, r, err)
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{"status": "success", "data": map[string]any{
		"ticket":    ticket,
		"expiresIn": WsTicketTTLSeconds,
	}})
}
