package server

import "testing"

func TestSweepAdminClampPage(t *testing.T) {
	p, l := adminClampPage(-1, -5, 10, 50)
	if p != 1 || l != 10 {
		t.Fatalf("negatives: got page=%d limit=%d", p, l)
	}
	p, l = adminClampPage(1, 200, 20, 50)
	if l != 50 {
		t.Fatalf("ceiling: got limit=%d", l)
	}
	p, l = adminClampPage(2, 10, 10, 50)
	if p != 2 || l != 10 {
		t.Fatalf("valid passthrough: got %d/%d", p, l)
	}
}

func TestSweepDoctorsTotalPages(t *testing.T) {
	if doctorsTotalPages(100, 0) != 0 {
		t.Fatal("take=0 must not divide by zero")
	}
	if doctorsTotalPages(0, 20) != 0 {
		t.Fatal("empty set must be 0 pages")
	}
	if doctorsTotalPages(100, 20) != 5 {
		t.Fatal("100/20 must be 5")
	}
}

func TestSweepPushEndpointAllowed(t *testing.T) {
	bad := []string{
		"http://example.com/x",
		"https://localhost/x",
		"https://127.0.0.1/x",
		"https://127.0.0.2/x",
		"https://10.1.2.3/x",
		"https://172.16.0.1/x",
		"https://192.168.1.1/x",
		"https://169.254.1.1/x",
		"https://0.0.0.0/x",
		"https://[::]/x",
		"https://2130706433/x",
		"https://0x7f.0.0.1/x",
		"https://user:pass@example.com/x",
		"https://singlelabel/x",
	}
	for _, e := range bad {
		if pushEndpointAllowed(e) {
			t.Fatalf("must reject %s", e)
		}
	}
	if !pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc") {
		t.Fatal("must allow public push host")
	}
}

func TestSweepAdminCSVEscape(t *testing.T) {
	if got := adminCSVEscape("=1+1"); got[0] != '\'' {
		t.Fatalf("formula not prefixed: %q", got)
	}
	if got := adminCSVEscape("  +2+2"); got[0] != '\'' {
		t.Fatalf("leading-space formula not prefixed: %q", got)
	}
	if got := adminCSVEscape("a\rb"); got[0] != '"' {
		t.Fatalf("bare CR must quote: %q", got)
	}
}
