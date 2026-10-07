import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";

/**
 * Called when the session is genuinely unrecoverable, so the app can surface a
 * "your session expired" notice instead of appearing to log the user out for no
 * reason. Kept as a hook so `AuthProvider` owns the reaction while this module
 * stays free of React.
 */
type SessionExpiredListener = (reason?: unknown) => void;
let sessionExpiredListener: SessionExpiredListener | null = null;

export const onSessionExpired = (listener: SessionExpiredListener | null) => {
    sessionExpiredListener = listener;
};

const api = axios.create({
    baseURL: API_URL,
    withCredentials: true,
    headers: {
        "Content-Type": "application/json",
    },
});

/* ------------------------------------------------------------------ *
 * CSRF double-submit token
 * ------------------------------------------------------------------ */

let csrfToken: string | null = null;
let csrfPromise: Promise<string | null> | null = null;

const fetchCsrfToken = async (): Promise<string | null> => {
    if (csrfToken) return csrfToken;
    if (!csrfPromise) {
        csrfPromise = axios
            .get(`${API_URL}/csrf-token`, { withCredentials: true })
            .then((res) => {
                csrfToken = res.data?.data?.csrfToken || null;
                return csrfToken;
            })
            .catch(() => null)
            .finally(() => {
                csrfPromise = null;
            });
    }
    return csrfPromise;
};

/** Forces the next mutating request to fetch a fresh token. */
export const invalidateCsrfToken = () => {
    csrfToken = null;
};

/* ------------------------------------------------------------------ *
 * Access-token refresh
 * ------------------------------------------------------------------ */

/**
 * Only one refresh may be in flight at a time, and every request that arrives
 * while it is running waits on that same promise.
 *
 * The access token is short-lived (15 minutes) and the server *rotates* the
 * refresh token on every use. Previously each 401 independently fired its own
 * `POST /auth/refresh`, so with N parallel requests the second and subsequent
 * calls presented an already-consumed token, were rejected, and logged the user
 * out. Because a dashboard fires several requests at once, this happened
 * roughly every session.
 */
let refreshPromise: Promise<void> | null = null;

/**
 * Increments on every *successful* refresh.
 *
 * A request records the current value when it is sent and may replay itself
 * once if it comes back 401 while the value is unchanged. That single rule
 * replaces the old global `refreshAttempts` counter, which had a real bug: with
 * three parallel 401s the counter hit its cap on the third request, so that
 * request failed even though a valid refresh was already in flight and about to
 * succeed. Comparing generations lets any number of requests wait on the same
 * refresh, and still guarantees a request is never replayed twice.
 */
let refreshGeneration = 0;

const refreshAccessToken = (): Promise<void> => {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        // The refresh call must carry the CSRF token like any other mutating
        // request. It goes through bare `axios` rather than the `api` instance
        // to avoid re-entering the response interceptor, so the header has to
        // be attached by hand. Without it the server answers 403 and the
        // single-flight fix above is inert.
        const token = await fetchCsrfToken();
        const response = await axios.post(
            `${API_URL}/auth/refresh`,
            {},
            {
                withCredentials: true,
                headers: token ? { "X-CSRF-Token": token } : undefined,
            }
        );

        if (response.status === 200) {
            refreshGeneration += 1;
        }
    })().finally(() => {
        refreshPromise = null;
    });

    return refreshPromise;
};

interface RetriableRequest extends InternalAxiosRequestConfig {
    /** Set once this request has already been replayed after a refresh. */
    _retried?: boolean;
    /** Refresh generation at the time the request was first sent. */
    _generation?: number;
}

/**
 * Endpoints that must never trigger a refresh-and-replay cycle.
 *
 * The auth endpoints answer 401 for a wrong password or code, and replaying
 * those would bounce the user to the login screen mid-form instead of showing
 * the actual error. `/realtime/ticket` is here for a different reason: a ticket
 * is single-use and valid for 30 seconds, so a replayed copy is worthless.
 */
const NO_RETRY_PATHS = [
    "/auth/refresh",
    "/auth/login",
    "/auth/register",
    "/auth/google",
    "/account/2fa/verify",
    "/account/forgot-password",
    "/account/reset-password",
    "/account/verify-email",
    "/account/resend-verification",
    "/realtime/ticket",
];

const isRetriable = (config: RetriableRequest | undefined): boolean => {
    if (!config) return false;
    if (config._retried) return false;
    if (NO_RETRY_PATHS.some((path) => (config.url || "").includes(path))) return false;
    // A refresh already succeeded while this request was in flight, so the 401
    // it produced is stale — replaying would just 401 again.
    return config._generation === refreshGeneration;
};

api.interceptors.request.use(async (config) => {
    const method = (config.method || "get").toLowerCase();
    const isMutating = !["get", "head", "options"].includes(method);

    // Stamp the generation before any await, so a refresh that lands while the
    // CSRF token is being fetched is still visible to the response interceptor.
    (config as RetriableRequest)._generation ??= refreshGeneration;

    if (isMutating && typeof window !== "undefined") {
        const token = await fetchCsrfToken();
        if (token) {
            config.headers.set("X-CSRF-Token", token);
        }
    }
    return config;
});

api.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const originalRequest = error.config as RetriableRequest | undefined;
        const status = error.response?.status;

        // A rejected CSRF token (for example after a server restart) would
        // otherwise surface as a confusing 403 on every future write.
        if (status === 403 && originalRequest) {
            const method = (originalRequest.method || "get").toLowerCase();
            if (!["get", "head", "options"].includes(method)) {
                invalidateCsrfToken();
            }
        }

        // `originalRequest` is absent for network-level failures (no response
        // either), so the guard is checked explicitly rather than relied on to
        // narrow inside `isRetriable`. Replaying a request with no config
        // cannot work, and a 401 always has one.
        if (status === 401 && originalRequest && isRetriable(originalRequest)) {
            originalRequest._retried = true;

            try {
                await refreshAccessToken();
                return api(originalRequest);
            } catch (refreshError) {
                // The session is genuinely gone. Tell the app, which clears the
                // cached user and explains why, preserving the current route so
                // the user lands back where they were after signing in.
                sessionExpiredListener?.(refreshError);
                return Promise.reject(refreshError);
            }
        }

        return Promise.reject(error);
    }
);

/**
 * Extracts a message safe to show a user.
 *
 * The API returns a curated `message` for expected failures, so prefer that
 * and fall back to something neutral rather than surfacing a raw network or
 * serialization error to someone in distress.
 */
export const getErrorMessage = (error: unknown, fallback = "Something went wrong"): string => {
    if (typeof error === "object" && error !== null) {
        const response = (error as AxiosError<{ message?: string }>).response;
        if (response?.data?.message) return response.data.message;
    }
    if (error instanceof Error && error.message) return error.message;
    return fallback;
};

/**
 * Obtains a short-lived ticket the WebSocket service will accept.
 *
 * A WebSocket handshake cannot carry an `Authorization` header, and the
 * `accessToken` cookie is host-only for the API origin, so a browser has no way
 * to present its session to the realtime service on a deployed setup. The API
 * issues a ticket that is valid for 30 seconds and can do exactly one thing:
 * open a socket. Going through the shared axios instance means the CSRF token
 * and a single-flight access-token refresh are handled for free.
 */
export const fetchRealtimeTicket = async (): Promise<string | null> => {
    try {
        const res = await api.post("/realtime/ticket");
        const ticket = res.data?.data?.ticket;
        return typeof ticket === "string" ? ticket : null;
    } catch {
        return null;
    }
};

export default api;
