package main

import "testing"

// TestRedisOptions covers the defect that made this service silently useless in
// every deployed environment: REDIS_URL is a URL everywhere it is set (compose,
// .env.example, Railway) because the Node API consumes it with
// `createClient({ url })`, but it was passed straight into `redis.Options.Addr`,
// which wants a bare `host:port`. The service then dialled a host literally
// named "redis://redis:6379" and subscribed to a channel on a connection that
// never opened — with /health still answering "ok".
func TestRedisOptions(t *testing.T) {
	tests := []struct {
		name     string
		raw      string
		wantAddr string
		wantPass string
		wantUser string
		wantDB   int
		wantTLS  bool
		wantErr  bool
	}{
		{
			name:     "compose style url",
			raw:      "redis://redis:6379",
			wantAddr: "redis:6379",
		},
		{
			// An empty Username tells go-redis to authenticate as "default", which
			// is what every managed Redis (Railway, Upstash, ElastiCache) expects.
			// Leaving it unset is therefore deliberate, and asserted here.
			name:     "url with password",
			raw:      "redis://default:s3cr3t@cache.internal:6379",
			wantAddr: "cache.internal:6379",
			wantPass: "s3cr3t",
		},
		{
			name:     "url with non-default username",
			raw:      "redis://app:pass@cache:6379",
			wantAddr: "cache:6379",
			wantPass: "pass",
			wantUser: "app",
		},
		{
			name:     "tls scheme",
			raw:      "rediss://cache:6380",
			wantAddr: "cache:6380",
			wantTLS:  true,
		},
		{
			name:     "db query parameter",
			raw:      "redis://cache:6379?db=3",
			wantAddr: "cache:6379",
			wantDB:   3,
		},
		{
			name:     "bare host and port still accepted",
			raw:      "localhost:6379",
			wantAddr: "localhost:6379",
		},
		{
			name:     "empty falls back to localhost",
			raw:      "",
			wantAddr: "localhost:6379",
		},
		{
			name:     "surrounding whitespace tolerated",
			raw:      "  redis://cache:6379  ",
			wantAddr: "cache:6379",
		},
		{
			name:    "unsupported scheme rejected",
			raw:     "http://cache:6379",
			wantErr: true,
		},
		{
			name:    "missing host rejected",
			raw:     "redis://",
			wantErr: true,
		},
		{
			name:    "non numeric db rejected",
			raw:     "redis://cache:6379?db=abc",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts, err := redisOptions(tc.raw)

			if tc.wantErr {
				if err == nil {
					t.Fatalf("redisOptions(%q) = nil error, want a failure", tc.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("redisOptions(%q) returned error: %v", tc.raw, err)
			}

			// The assertion that matters: Addr must be a dial string, never a URL.
			if opts.Addr != tc.wantAddr {
				t.Errorf("Addr = %q, want %q", opts.Addr, tc.wantAddr)
			}
			if opts.Password != tc.wantPass {
				t.Errorf("Password = %q, want %q", opts.Password, tc.wantPass)
			}
			if opts.Username != tc.wantUser {
				t.Errorf("Username = %q, want %q", opts.Username, tc.wantUser)
			}
			if opts.DB != tc.wantDB {
				t.Errorf("DB = %d, want %d", opts.DB, tc.wantDB)
			}
			if got := opts.TLSConfig != nil; got != tc.wantTLS {
				t.Errorf("TLS configured = %v, want %v", got, tc.wantTLS)
			}
		})
	}
}
