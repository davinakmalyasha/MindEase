package server

import "testing"

func TestPasswordHashRoundTrip(t *testing.T) {
	hash, err := hashPassword("Patient@123")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !verifyPassword("Patient@123", hash) {
		t.Fatal("the correct password must verify")
	}
	if verifyPassword("Patient@124", hash) {
		t.Fatal("a wrong password must not verify")
	}
}

func TestVerifyPasswordRejectsMalformedHashes(t *testing.T) {
	for _, bad := range []string{"", "not-a-hash", "$argon2id$v=19$m=0,t=0,p=0$AAAA$AAAA"} {
		if verifyPassword("x", bad) {
			t.Fatalf("malformed hash %q must not verify", bad)
		}
	}
}

func TestDummyHashNeverVerifies(t *testing.T) {
	// The miss path verifies against this so an unknown account costs the same
	// wall time as a real one; it must never produce a true.
	if verifyPassword("anything", dummyPasswordHash) {
		t.Fatal("the dummy hash must never verify")
	}
}
