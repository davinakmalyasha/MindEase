package hub

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 50 * time.Second
	maxMsgSize = 512
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Restrict cross-site WebSocket hijacking (CSWSH): only origins listed in
	// ALLOWED_ORIGINS (comma-separated) or FRONTEND_URL may connect. Localhost
	// is always allowed for local development.
	CheckOrigin: checkOrigin,
}

var allowedOrigins []string

func init() {
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			allowedOrigins = append(allowedOrigins, o)
		}
	}
	if fe := strings.TrimSpace(os.Getenv("FRONTEND_URL")); fe != "" {
		allowedOrigins = append(allowedOrigins, fe)
	}
	allowedOrigins = append(allowedOrigins, "http://localhost:3000", "http://127.0.0.1:3000")
}

func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Non-browser clients (e.g. mobile) omit Origin — allow when they
		// authenticate with a token, matching the pre-existing behavior.
		return true
	}
	for _, o := range allowedOrigins {
		if strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

// ServeWS authenticates, then upgrades the connection and registers the client
// with the hub.
//
// Authentication deliberately happens *before* the upgrade. The previous order
// completed a 101 handshake first and only then validated the token, so an
// unauthenticated caller held a live socket for the duration of the auth check
// and the client could not tell a rejected handshake from a normal disconnect —
// its reconnect loop would retry a bad ticket indefinitely.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	claims, err := authenticateRequest(r)
	if err != nil {
		log.Printf("auth rejected: %v", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	client := &Client{
		ID:   claims.UserID,
		Send: make(chan Event, 64),
	}
	if err := h.Register(claims.UserID, client); err != nil {
		log.Printf("connection limit reached for user %d: %v", claims.UserID, err)
		// Best-effort, but not silent. A failed close frame leaves the peer
		// hanging on a socket we are about to drop, with no explanation.
		if err := conn.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "too many connections"),
		); err != nil {
			log.Printf("user %d over cap: close frame failed: %v", claims.UserID, err)
		}
		if err := conn.Close(); err != nil {
			log.Printf("user %d over cap: close failed: %v", claims.UserID, err)
		}
		return
	}

	log.Printf("user %d connected (role=%s)", claims.UserID, claims.Role)

	go h.writePump(conn, client)
	go h.readPump(conn, client)
}

func authenticateRequest(r *http.Request) (*Claims, error) {
	// 1. Authorization bearer header (explicit)
	if h := r.Header.Get("Authorization"); len(h) > 7 && h[:7] == "Bearer " {
		return Authenticate(h[7:])
	}
	// 2. accessToken cookie (same-site WebSocket handshake from the app)
	if c, err := r.Cookie("accessToken"); err == nil {
		return Authenticate(c.Value)
	}
	// 3. ?token= query param (fallback for non-browser clients)
	if t := r.URL.Query().Get("token"); t != "" {
		return Authenticate(t)
	}
	return nil, http.ErrNoCookie
}

func (h *Hub) writePump(conn *websocket.Conn, c *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		h.Unregister(c.ID, c)
		// Errors here mean the socket was already gone. Returning is correct
		// either way; logging it is what distinguishes a clean disconnect from
		// one the network ate.
		if err := conn.Close(); err != nil {
			log.Printf("user %d write pump: close: %v", c.ID, err)
		}
	}()

	for {
		select {
		case event, ok := <-c.Send:
			if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				log.Printf("user %d write pump: set deadline: %v", c.ID, err)
				return
			}
			if !ok {
				if err := conn.WriteMessage(websocket.CloseMessage, []byte{}); err != nil {
					log.Printf("user %d write pump: close frame: %v", c.ID, err)
				}
				return
			}
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		case <-ticker.C:
			if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				log.Printf("user %d write pump: ping deadline: %v", c.ID, err)
				return
			}
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) readPump(conn *websocket.Conn, c *Client) {
	defer func() {
		h.Unregister(c.ID, c)
		if err := conn.Close(); err != nil {
			log.Printf("user %d read pump: close: %v", c.ID, err)
		}
	}()

	conn.SetReadLimit(maxMsgSize)
	if err := conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		log.Printf("user %d read pump: initial deadline: %v", c.ID, err)
		return
	}
	conn.SetPongHandler(func(string) error {
		// A failed deadline extension means the pong was not honoured, so the
		// connection is already suspect; surfacing it beats letting the stale
		// deadline quietly reap a healthy client later.
		if err := conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
			return err
		}
		return nil
	})

	// Client messages are ignored — this service is push-only.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
