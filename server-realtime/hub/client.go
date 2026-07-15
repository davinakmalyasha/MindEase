package hub

import (
	"log"
	"net/http"
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
	// Allow the Next.js dev/prod origins; real auth happens via JWT.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ServeWS upgrades the connection, authenticates via token (cookie or query),
// and registers the client with the hub.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	claims, err := authenticateRequest(r)
	if err != nil {
		log.Printf("auth error: %v", err)
		conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, err.Error()))
		conn.Close()
		return
	}

	client := &Client{
		ID:   claims.UserID,
		Send: make(chan Event, 64),
	}
	h.Register(claims.UserID, client)

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
		conn.Close()
	}()

	for {
		select {
		case event, ok := <-c.Send:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) readPump(conn *websocket.Conn, c *Client) {
	defer func() {
		h.Unregister(c.ID, c)
		conn.Close()
	}()

	conn.SetReadLimit(maxMsgSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Client messages are ignored — this service is push-only.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
