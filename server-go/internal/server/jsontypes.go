package server

import "time"

// JSTime marshals like JavaScript's Date#toISOString: UTC, milliseconds, `Z`.
// The client parses these with `new Date(...)` and formats locally, so the
// shape matters more than the precision.
type JSTime time.Time

func (t JSTime) MarshalJSON() ([]byte, error) {
	s := time.Time(t).UTC().Format("2006-01-02T15:04:05.000Z")
	return []byte(`"` + s + `"`), nil
}

func jsTime(t *time.Time) *JSTime {
	if t == nil {
		return nil
	}
	v := JSTime(*t)
	return &v
}

func jsTimeValue(t time.Time) JSTime { return JSTime(t) }
