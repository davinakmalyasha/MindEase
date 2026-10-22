import http from "k6/http";
import { check } from "k6";
import { doctorIDs, login } from "./lib.js";

// Two API processes behind no load balancer: every request is sent to each
// base URL directly. A session minted by the first process must be accepted by
// the second, which is what "stateless replicas" means here. Both processes
// also share Redis (rate limits) and MySQL (state), both of which are checked
// indirectly by the authenticated reads.
const bases = (__ENV.BASE_URLS || "http://localhost:5000,http://localhost:5001")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export const options = {
  vus: 5,
  iterations: 25,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
  },
};

export function setup() {
  const token = login(bases[0]);
  return { bases, token, doctorIds: doctorIDs(bases[0], token) };
}

export default function (data) {
  const forwardedFor = `10.88.${__VU}.${__ITER % 100}`;
  const auth = { "X-Forwarded-For": forwardedFor, Cookie: `accessToken=${data.token}` };
  const anon = { "X-Forwarded-For": forwardedFor };
  const doctorId = data.doctorIds[__ITER % data.doctorIds.length];

  for (const base of data.bases) {
    check(http.get(`${base}/api/users/profile`, { headers: auth }), {
      [`profile is 200 on ${base}`]: (r) => r.status === 200,
    });
    check(http.get(`${base}/api/doctors?limit=10`, { headers: anon }), {
      [`directory is 200 on ${base}`]: (r) => r.status === 200,
    });
    check(http.get(`${base}/api/doctors/${doctorId}`, { headers: anon }), {
      [`doctor detail is 200 on ${base}`]: (r) => r.status === 200,
    });
  }
}
