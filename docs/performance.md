# Performance

Measured, not claimed. Every number below comes from one machine running the
API, MySQL, Redis and the load generator together. The results are useful for
comparing configurations and for showing where the next bottleneck is; they are
not a capacity guarantee, and there is no deployment behind them.

## Environment

| Component | Value |
|---|---|
| Host | Windows 11 Home, AMD Ryzen 5 7520U (4 cores / 8 threads), 7.9 GB RAM |
| API | Go 1.27.0 (measured); the repository now pins 1.27.3 for CVE-2026-111943; single process unless noted |
| MySQL | 9.6 (Laragon), same host |
| Redis | 8.10.1, same host |
| Load generator | k6 0.57.0, same host |
| Transport | plain HTTP on loopback; no TLS, proxy, CDN or network latency |

The measured machine had no Docker, so the stack ran from the repository's local
services rather than the compose image. The compose `perf` profile is still the
reproducible path for anyone with Docker.

## Workload

Each iteration sends four requests:

- `GET /api/doctors?limit=20` — cached directory read
- `GET /api/doctors/{id}` — cached detail read
- `GET /api/users/profile` — authenticated MySQL read
- `GET /api/wellness/mood?days=30` — authenticated MySQL read

Setup signs in once with the seeded patient (the Argon2 login cost is therefore
excluded from the steady-state numbers) and the resulting access token is reused.
The script ramps for 20s, holds for 60s, and ramps down for 10s.

`X-Forwarded-For` is varied per iteration, so each iteration looks like a
different client to the 300-per-15-minute IP limiter. This is deliberate: with
one IP the test would mostly measure the limiter. The limiter itself is covered
by tests, and no limit is disabled for the benchmark. The compose API runs with
`NODE_ENV=production`, which is what makes the last XFF entry authoritative.

## Results

All runs completed with **zero failed requests** and 100% of checks passing.

| Run | VUs | `DB_MAX_OPEN_CONNS` | Throughput | p95 | p99 | Pool waits | Time waiting |
|---|---:|---:|---:|---:|---:|---:|---:|
| Mixed reads | 50 | 20 | 448 req/s | 12.0 ms | 27.7 ms | 69 | 0.24 s |
| Mixed reads | 50 | 5 | 445 req/s | 11.8 ms | 25.6 ms | 584 | 0.97 s |
| Mixed reads | 150 | 20 | 1,024 req/s | 89.0 ms | 152.4 ms | 1,034 | 4.0 s |
| Mixed reads | 150 | 5 | 1,012 req/s | 96.5 ms | 212.0 ms | 61,002 | 599.5 s |

Pool wait figures are per process. The 5-connection process had already served
the 50-VU run before the 150-VU run, so the last row uses the delta rather than
the cumulative lifetime counters.

Smoke test (one VU, five iterations, including the login): 28/28 checks, p95
36.8 ms, 0 failures.

### What the pool experiment shows

At 50 VUs (about 450 req/s), five connections were enough: p99 was unchanged and
the extra pool only reduced waiting. At 150 VUs (about 1,000 req/s), the
20-connection pool cut p99 from 212 ms to 152 ms and reduced cumulative wait
time from about 600 seconds to 4 seconds. Throughput was essentially unchanged,
which means the host had reached its own ceiling — k6, the Go process, MySQL and
Redis were sharing four cores.

The useful conclusion is not "20 is the right number". It is that the pool is a
queueing control, not a throughput multiplier: size it from
`replicas × MaxOpenConns` against MySQL's `max_connections`, measure wait
counters, and add a pooler or a replica when waiting starts to show in p99.

## Multi-process check

Two API processes were started on `:5000` and `:5001` with the same database,
Redis and signing secrets. A token minted by the first was accepted by the
second, and both reported the traffic:

- 153/153 checks passed, 0 failed
- 25 iterations across both processes, p95 95.6 ms, p99 148.1 ms
- Both `/metrics` listeners showed requests after the run

This proves the session and state model is replica-safe. It does not prove the
upload path (which needs shared S3), and it does not test duplicate job sends —
the claims are the mechanism, and they are exercised separately.

## Reproduce

With Docker, start and seed the stack first (`make up` sets the payment-simulator
opt-in the API requires in production mode), then:

```bash
docker compose run --rm --no-deps api seed
docker compose --profile perf run --rm k6 run /scripts/smoke.js
docker compose --profile perf run --rm k6                  # 10 VUs
docker compose --profile perf run --rm -e VUS=150 k6      # saturation run
```

For the pool comparison, set `DB_MAX_OPEN_CONNS=5 DB_MAX_IDLE_CONNS=5` for the
API (for example in `.env` or a compose override), restart the API, and repeat
the same run.

Locally, with k6 installed:

```bash
# Seeded local API; production mode makes X-Forwarded-For authoritative.
# ALLOW_PAYMENT_SIMULATOR is required because NODE_ENV=production otherwise
# refuses the simulator the local .env uses.
cd server-go
NODE_ENV=production ALLOW_PAYMENT_SIMULATOR=true bash scripts/dev.sh

# Another terminal, from the repository root:
k6 run -e BASE_URL=http://localhost:5000 perf/k6/load.js
k6 run -e BASE_URL=http://localhost:5000 -e VUS=150 perf/k6/load.js
```

For the two-process check, run a second replica (the dev script preserves an
explicitly exported `PORT`) and point the script at both:

```bash
cd server-go && PORT=5001 bash scripts/dev.sh
k6 run -e BASE_URLS=http://localhost:5000,http://localhost:5001 \
  perf/k6/multi-replica.js
```

Metrics and pool counters are on the private listener:

```bash
METRICS_ADDR=127.0.0.1:9091 METRICS_TOKEN=local-scrape bash scripts/dev.sh
curl -H "Authorization: Bearer local-scrape" http://127.0.0.1:9091/metrics \
  | grep mindease_db_pool
```

## What this does not measure

TLS and proxy overhead, network latency, write throughput, AI calls, a soak run
longer than 90 seconds, or a machine larger than a low-power laptop. Treat the
1,000 req/s figure as "the host was saturated here", not "the API's ceiling".
