import axios from "axios";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api";

const api = axios.create({
    baseURL: API_URL,
    withCredentials: true,
    headers: {
        "Content-Type": "application/json",
    },
});

// CSRF double-submit token: fetched once, echoed on all mutating requests
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

api.interceptors.request.use(async (config) => {
    const method = (config.method || "get").toLowerCase();
    const isMutating = !["get", "head", "options"].includes(method);
    if (isMutating && typeof window !== "undefined") {
        const token = await fetchCsrfToken();
        if (token) {
            config.headers.set("X-CSRF-Token", token);
        }
    }
    return config;
});

// Response interceptor for API calls
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        // Refresh token once on 401, then retry
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;

            try {
                await axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true });
                return api(originalRequest);
            } catch (refreshError) {
                if (typeof window !== "undefined") {
                    localStorage.removeItem("user");
                    if (!window.location.pathname.startsWith("/login")) {
                        window.location.href = "/login";
                    }
                }
                return Promise.reject(refreshError);
            }
        }

        return Promise.reject(error);
    }
);

// Extract a friendly error message from an API error
export const getErrorMessage = (error: any, fallback = "Something went wrong") => {
    return error?.response?.data?.message || error?.message || fallback;
};

export default api;
