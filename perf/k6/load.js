import http from "k6/http";
import { check, sleep } from "k6";
import { setupAuth } from "./lib.js";

// Mixed read workload: two cached public reads and two authenticated DB reads.
// The pool is what this exercises; writes are covered by the integration suite
// and the browser journeys, and benchmarking them against one seeded patient
// would measure row-lock contention rather than throughput.
//
// VUS overrides the target for a saturation run (default 10). The shape stays
// the same so the two results are comparable.
const targetVUs = Number(__ENV.VUS || 10);

export const options = {
  scenarios: {
    mixed_reads: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: targetVUs },
        { duration: "60s", target: targetVUs },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
  },
};

export function setup() {
  return setupAuth(__ENV.BASE_URL);
}

export default function (data) {
  const base = __ENV.BASE_URL;
  // Each iteration looks like a different client to the IP limiter, which is
  // how a real deployment sees many browsers. The limiter's behavior under a
  // single IP is tested directly; without this the benchmark would just measure
  // the 300-per-15-minute ceiling.
  const forwardedFor = `10.77.${__VU}.${__ITER % 250}`;
  const anon = { "X-Forwarded-For": forwardedFor };
  const auth = {
    "X-Forwarded-For": forwardedFor,
    Cookie: `accessToken=${data.token}`,
  };
  const doctorId =
    data.doctorIds[Math.floor(Math.random() * data.doctorIds.length)];

  const responses = [
    http.get(`${base}/api/doctors?limit=20`, {
      headers: anon,
      tags: { name: "directory" },
    }),
    http.get(`${base}/api/doctors/${doctorId}`, {
      headers: anon,
      tags: { name: "doctor-detail" },
    }),
    http.get(`${base}/api/users/profile`, {
      headers: auth,
      tags: { name: "profile" },
    }),
    http.get(`${base}/api/wellness/mood?days=30`, {
      headers: auth,
      tags: { name: "mood-history" },
    }),
  ];

  for (const res of responses) {
    check(res, { "status is 200": (r) => r.status === 200 });
  }
  sleep(0.2 + Math.random() * 0.3);
}
