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

	// Drop accounting. `PublishToUser` drops rather than blocks, which is the
	// right call - one stalled socket must not stall the hub - but it made the
	// behaviour invisible. A clinician whose risk alert silently vanished, or a
	// patient whose message never arrived, looked identical to a bug in their
	// own client. These counters are the difference between "the socket was
	// slow" and "we have no idea".
	//
	// Split by class because the two are not equally serious and an operator
	// should be able to tell them apart at a glance.
	droppedCritical uint64 // risk alerts, messages, crisis events
	droppedCosmetic uint64 // typing indicators and similar
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

// criticalTypes are the events where a dropped delivery is a clinical or
// communication failure rather than a cosmetic one.
//
// The distinction drives two things: which counter a drop lands in, and the
// fact that a caller can ask for priority. But note what priority cannot do:
// if a socket's buffer is full, it is full. A critical event cannot displace
// an already-queued one - the channel is FIFO and there is no room made for
// it. So this classification improves *reporting*, and gives the caller a
// cheap signal, but it does not claim to guarantee delivery under back
// pressure. Pretending otherwise would be worse than the silent drop.
//
// The previous contents of this map were:
//
//	message:new, risk:new, risk:updated, appointment:new, appointment:update, crisis
//
// Five of those six are published by nothing anywhere in the repository - a
// grep for `risk:new`, `risk:updated`, `crisis` and `appointment:new` finds them
// only in this file and in its test. Meanwhile `sos:alert` and `risk:alert`, the
// two events this service exists to deliver, were absent and so were counted as
// cosmetic. The observable consequence: the counters built specifically to
// surface lost clinical alerts reported zero critical drops in production, and
// counted every real one as cosmetic. The doc comment two declarations above
// named `risk:new` as the example of an alert that never arrived.
//
// The list below is the actual `RealtimeEventType` union in
// server/src/services/realtime.service.ts. `realtime-contract.test.ts` asserts
// the two agree, which is the check that was missing and is what let the drift
// persist: nothing compared this map to the TypeScript union, because the Go
// service has no event-type list of its own to compare against - it forwards
// `type` as an opaque string. Adding a list here is what created the
// possibility of the drift, and adding the assertion is what closes it.
var criticalTypes = map[string]bool{
	// A clinician's worklist: someone disclosed thoughts of self-harm.
	"risk:alert": true,
	// The patient pressed the button marked "I need help now".
	"sos:alert": true,
	// A direct message to a named clinician or patient. In a therapy chat this
	// can itself be the disclosure.
	"message:new": true,
	// A new appointment or a session starting.
	"appointment:join": true,
	// A durable inbox entry. Carries the same disclosure text as the events
	// above, so it is not cosmetic either.
	"notification:new": true,
}

// IsCritical reports whether an event type is one whose loss matters beyond
// the screen it would have updated.
func IsCritical(eventType string) bool {
	return criticalTypes[eventType]
}

// PublishToUser delivers an event to every connection of the user.
//
// Non-blocking: a socket whose buffer is full is skipped rather than allowed
// to stall the hub for every other user. That trade is right - one stalled
// client must not become a service-wide outage - but it used to be silent, so
// the drop is counted by class and readable via DropStats.
func (h *Hub) PublishToUser(userID int64, event Event) {
	critical := IsCritical(event.Type)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients[userID] {
		select {
		case c.Send <- event:
		default:
			// Slow consumer - drop the event to avoid blocking the hub.
			// Counted under the write lock we already hold, so this needs no
			// second lock and cannot race with itself.
			if critical {
				h.droppedCritical++
			} else {
				h.droppedCosmetic++
			}
		}
	}
}

// DropStats reports how many events have been dropped, by class, since the
// hub was created. Returned to the /health endpoint so the number is visible
// without a debugger attached.
type DropStats struct {
	Critical uint64 `json:"droppedCritical"`
	Cosmetic uint64 `json:"droppedCosmetic"`
}

func (h *Hub) DropStats() DropStats {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return DropStats{
		Critical: h.droppedCritical,
		Cosmetic: h.droppedCosmetic,
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
