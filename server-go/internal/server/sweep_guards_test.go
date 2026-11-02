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

func TestSweepClampContract(t *testing.T) {
	// Shared pagination contract: coerce, never 500, never LIMIT 0.
	if clampPage(-3, 1) != 1 || clampPage(2, 1) != 2 {
		t.Fatal("page must floor at fallback")
	}
	// Notifications family: negative keeps old take=1 behavior, over max clamps.
	if clampLimit(-5, 1, 30) != 1 || clampLimit(99, 1, 30) != 30 || clampLimit(20, 1, 30) != 20 {
		t.Fatal("notification ceiling 30 with take=1 floor")
	}
	// Directory family: negative restores default page size.
	if clampLimit(-5, 20, 50) != 20 || clampLimit(99, 20, 50) != 50 {
		t.Fatal("directory ceiling 50 with default-size floor")
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

func TestSweepOfficeMagic(t *testing.T) {
	zip := []byte{'P', 'K', 0x03, 0x04, 0x14, 0x00}
	if !msgSniffedTypeAllowed(".docx", "application/zip", zip) {
		t.Fatal("valid docx ZIP header must pass")
	}
	if msgSniffedTypeAllowed(".docx", "application/zip", []byte("<html><body>")) {
		t.Fatal("HTML smuggled as docx must fail")
	}
	ole := []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00}
	if !msgSniffedTypeAllowed(".doc", "application/octet-stream", ole) {
		t.Fatal("valid doc OLE header must pass")
	}
	if msgSniffedTypeAllowed(".doc", "application/msword", []byte("GIF89a...")) {
		t.Fatal("GIF bytes as doc must fail")
	}
}
