// Package hub implements the WebSocket connection hub for the MindEase
// realtime service: users connect, join a room keyed by user ID, and
// receive events pushed via Redis pub/sub.
package hub

import (
	"errors"
	"sync"
)

// ErrTooManyConnections is returned by Register when a connection would exceed
// either the per-user or the global connection cap. The caller is expected to
// reject the socket and not start its pumps.
var ErrTooManyConnections = errors.New("connection limit reached")

// Default connection caps. Overridable via env so an operator can size the
// service for their own memory budget.
const (
	DefaultMaxPerUserConnections = 5
	DefaultMaxTotalConnections   = 10000
)

// Limits bounds how many concurrent sockets the hub will hold.
type Limits struct {
	MaxPerUser int
	MaxTotal   int
}

// DefaultLimits returns the built-in caps.
func DefaultLimits() Limits {
	return Limits{
		MaxPerUser: DefaultMaxPerUserConnections,
		MaxTotal:   DefaultMaxTotalConnections,
	}
}

// Event is a message pushed to a connected user.
type Event struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// Client is a single WebSocket connection owned by a user.
type Client struct {
	ID   int64
	Send chan Event
}

// Hub routes events to clients, fanning out to all connections of a user.
type Hub struct {
	mu      sync.RWMutex
	clients map[int64]map[*Client]bool
	total   int
	limits  Limits
}

// New creates an empty hub with the given limits. Non-positive limits fall
// back to the defaults so a misconfigured env can never disable the cap.
func New(limits Limits) *Hub {
	if limits.MaxPerUser <= 0 {
		limits.MaxPerUser = DefaultMaxPerUserConnections
	}
	if limits.MaxTotal <= 0 {
		limits.MaxTotal = DefaultMaxTotalConnections
	}
	return &Hub{
		clients: make(map[int64]map[*Client]bool),
		limits:  limits,
	}
}

// Register adds a client to the user's room.
//
// It returns ErrTooManyConnections — and registers nothing — when either cap
// would be exceeded. The check and the insert happen under one lock so two
// concurrent connections cannot both observe a free slot.
func (h *Hub) Register(userID int64, c *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.clients[userID]
	if len(room) >= h.limits.MaxPerUser {
		return ErrTooManyConnections
	}
	if h.total >= h.limits.MaxTotal {
		return ErrTooManyConnections
	}

	if room == nil {
		room = make(map[*Client]bool)
		h.clients[userID] = room
	}
	room[c] = true
	h.total++
	return nil
}

// Unregister removes a client, cleaning up empty rooms. It is safe to call
// multiple times for the same client (e.g. from both writePump and readPump
// goroutines): the channel is closed exactly once, only if the client was
// still registered.
func (h *Hub) Unregister(userID int64, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room := h.clients[userID]; room != nil {
		if _, ok := room[c]; ok {
			delete(room, c)
			close(c.Send)
			h.total--
			if len(room) == 0 {
				delete(h.clients, userID)
			}
		}
	}
}

// PublishToUser delivers an event to every connection of the user.
func (h *Hub) PublishToUser(userID int64, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients[userID] {
		select {
		case c.Send <- event:
		default:
			// Slow consumer — drop the event to avoid blocking the hub.
		}
	}
}

// UserCount returns the number of connected users.
func (h *Hub) UserCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// ConnectionCount returns the total number of open sockets across all users.
func (h *Hub) ConnectionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.total
}
