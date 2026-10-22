import http from "k6/http";
import { check } from "k6";

// One sign-in per test run, shared by every VU. The login limiter is real and
// deliberately not bypassed; the load scenarios reuse the resulting access
// token instead of authenticating per iteration.
export function login(baseURL) {
  const email = __ENV.PERF_EMAIL || "patient@mindease.app";
  const password = __ENV.PERF_PASSWORD || "Patient@123";

  const csrfRes = http.get(`${baseURL}/api/csrf-token`, {
    tags: { name: "csrf-token" },
  });
  check(csrfRes, { "csrf token is 200": (r) => r.status === 200 });
  const csrf = (csrfRes.cookies.csrfToken || [])[0]?.value;
  if (!csrf) throw new Error("no csrfToken cookie; is the API reachable?");

  const res = http.post(
    `${baseURL}/api/auth/login`,
    JSON.stringify({ email, password }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        Cookie: `csrfToken=${csrf}`,
      },
      tags: { name: "login" },
    },
  );
  check(res, { "login is 200": (r) => r.status === 200 });
  const access = (res.cookies.accessToken || [])[0]?.value;
  if (!access) {
    throw new Error(`login returned ${res.status} without an accessToken; run the seed first`);
  }
  return access;
}

export function doctorIDs(baseURL, access) {
  const res = http.get(`${baseURL}/api/doctors?limit=8`, {
    headers: { Cookie: `accessToken=${access}` },
    tags: { name: "doctor-list-setup" },
  });
  check(res, { "doctor list is 200": (r) => r.status === 200 });
  const rows = res.json("data.rows") || [];
  if (rows.length === 0) throw new Error("seed produced no approved doctors");
  return rows.map((row) => row.id);
}

export function setupAuth(baseURL) {
  const token = login(baseURL);
  return { token, doctorIds: doctorIDs(baseURL, token) };
}
