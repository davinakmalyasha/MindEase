package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// pushSend delivers a notification to every device the user has registered.
//
// Like PushService.send in the Node service: silently no-ops when VAPID is not
// configured, and prunes a subscription the push service says is gone (404/410)
// rather than retrying it forever. Individual failures are logged, not returned:
// push is a best-effort channel beside the stored in-app row.
func (s *Server) pushSend(ctx context.Context, userID, title, body, url string) {
	publicKey := strings.TrimSpace(os.Getenv("VAPID_PUBLIC_KEY"))
	privateKey := strings.TrimSpace(os.Getenv("VAPID_PRIVATE_KEY"))
	if publicKey == "" || privateKey == "" {
		return
	}
	subscriber := strings.TrimSpace(os.Getenv("VAPID_SUBJECT"))
	if subscriber == "" {
		subscriber = "mailto:no-reply@mindease.app"
	}
	if url == "" {
		url = "/dashboard"
	}

	type subscription struct {
		id       string
		endpoint string
		p256dh   string
		auth     string
	}
	var subscriptions []subscription
	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, endpoint, p256dh, auth FROM `PushSubscription` WHERE userId = ?", userID)
	if err != nil {
		s.Log.Warn("push: could not load subscriptions", "userId", userID, "err", err)
		return
	}
	for rows.Next() {
		var one subscription
		if err := rows.Scan(&one.id, &one.endpoint, &one.p256dh, &one.auth); err != nil {
			rows.Close()
			s.Log.Warn("push: could not read a subscription", "userId", userID, "err", err)
			return
		}
		subscriptions = append(subscriptions, one)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return
	}
	if len(subscriptions) == 0 {
		return
	}

	payload, err := json.Marshal(map[string]string{"title": title, "body": body, "url": url})
	if err != nil {
		return
	}
	options := &webpush.Options{
		Subscriber:      subscriber,
		VAPIDPublicKey:  publicKey,
		VAPIDPrivateKey: privateKey,
		TTL:             3600,
		Urgency:         webpush.UrgencyNormal,
	}
	for _, one := range subscriptions {
		response, err := webpush.SendNotification(payload, &webpush.Subscription{
			Endpoint: one.endpoint,
			Keys:     webpush.Keys{P256dh: one.p256dh, Auth: one.auth},
		}, options)
		if response != nil {
			response.Body.Close()
		}
		if err == nil {
			continue
		}
		if response != nil && (response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone) {
			if _, deleteErr := s.DB.ExecContext(context.Background(),
				"DELETE FROM `PushSubscription` WHERE id = ?", one.id); deleteErr != nil {
				s.Log.Warn("push: could not prune a dead subscription", "userId", userID, "err", deleteErr)
			}
			continue
		}
		s.Log.Warn("push: delivery failed", "userId", userID, "err", err)
	}
}
