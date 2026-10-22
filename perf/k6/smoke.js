import http from "k6/http";
import { check } from "k6";
import { setupAuth } from "./lib.js";

// Five iterations, one VU: a fast "is the perf target actually alive and
// seeded?" check before a longer run, and the shape the perf workflow can use
// as a gate.
export const options = {
  vus: 1,
  iterations: 5,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
};

export function setup() {
  return setupAuth(__ENV.BASE_URL);
}

export default function (data) {
  const base = __ENV.BASE_URL;
  const id = data.doctorIds[0];
  const auth = { Cookie: `accessToken=${data.token}` };

  check(http.get(`${base}/api/health`), { "health is 200": (r) => r.status === 200 });
  check(http.get(`${base}/api/readyz`), { "readyz is 200": (r) => r.status === 200 });
  check(http.get(`${base}/api/doctors?limit=20`), {
    "directory is 200": (r) => r.status === 200,
  });
  check(http.get(`${base}/api/doctors/${id}`), {
    "doctor detail is 200": (r) => r.status === 200,
  });
  check(http.get(`${base}/api/users/profile`, { headers: auth }), {
    "profile is 200": (r) => r.status === 200,
  });
}
