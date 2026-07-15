// Package hub implements the WebSocket connection hub for the MindEase
// realtime service: users connect, join a room keyed by user ID, and
// receive events pushed via Redis pub/sub.
package hub

import (
	"sync"
)

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
}

// New creates an empty hub.
func New() *Hub {
	return &Hub{clients: make(map[int64]map[*Client]bool)}
}

// Register adds a client to the user's room.
func (h *Hub) Register(userID int64, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*Client]bool)
	}
	h.clients[userID][c] = true
}

// Unregister removes a client, cleaning up empty rooms.
func (h *Hub) Unregister(userID int64, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room := h.clients[userID]; room != nil {
		delete(room, c)
		close(c.Send)
		if len(room) == 0 {
			delete(h.clients, userID)
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
