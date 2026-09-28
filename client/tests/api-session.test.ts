import { beforeEach, describe, expect, it, vi } from "vitest";

const CSRF_TOKEN = "csrf-token-value";

interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
}

const state = vi.hoisted(() => ({
    calls: [] as { method: string; url: string; headers: Record<string, string> }[],
    refresh: async () => ({ status: 200, data: { status: "success" } }),
    guarded: async () => ({ status: 200, data: { status: "success" } }),
}));

const countRefresh = () =>
    state.calls.filter((c) => c.url.includes("/auth/refresh")).length;

const unauthorized = () => {
    const error: any = new Error("Request failed with status code 401");
    error.response = { status: 401, data: {} };
    return error;
};

/** Minimal `AxiosHeaders`: the interceptor calls `.set()`, and tests read `.toJSON()`. */
const makeHeaders = (initial: Record<string, string> = {}) => {
    const store: Record<string, string> = { ...initial };
    return {
        store,
        set: (key: string, value: string) => {
            store[key] = value;
            return this;
        },
        get: (key: string) => store[key],
        toJSON: () => ({ ...store }),
    };
};

vi.mock("axios", () => {
    const makeAxios = () => {
        const requestInterceptors: any[] = [];
        const responseInterceptors: any[] = [];

        const instance: any = (config: any) => instance.request(config);

        instance.interceptors = {
            request: { use: (fn: any) => requestInterceptors.push(fn) },
            response: { use: (ok: any, fail: any) => responseInterceptors.push({ ok, fail }) },
        };

        instance.request = async (config: any) => {
            let cfg = { ...config, headers: makeHeaders(config?.headers ?? {}) };
            for (const fn of requestInterceptors) cfg = await fn(cfg);

            state.calls.push({
                method: (cfg.method ?? "get").toLowerCase(),
                url: String(cfg.url ?? ""),
                headers: cfg.headers.toJSON(),
            });

            try {
                return await state.guarded();
            } catch (error: any) {
                error.config = cfg;
                for (const { fail } of responseInterceptors) {
                    if (!fail) continue;
                    // The interceptor either resolves with a replayed request or
                    // rejects; both need to propagate to the caller.
                    try {
                        return await fail(error);
                    } catch (finalError) {
                        throw finalError;
                    }
                }
                throw error;
            }
        };

        for (const method of ["get", "delete"] as const) {
            instance[method] = (url: string, config: any = {}) =>
                instance.request({ ...config, url, method });
        }
        for (const method of ["post", "put", "patch"] as const) {
            instance[method] = (url: string, data?: unknown, config: any = {}) =>
                instance.request({ ...config, url, data, method });
        }

        instance.create = () => makeAxios();
        instance.defaults = { headers: makeHeaders() };

        return instance;
    };

    const bare: any = async (method: string, url: string, data?: unknown, config: any = {}) => {
        state.calls.push({
            method,
            url,
            headers: (config.headers ?? {}) as Record<string, string>,
        });
        if (url.includes("/csrf-token")) {
            return { status: 200, data: { status: "success", data: { csrfToken: CSRF_TOKEN } } };
        }
        if (url.includes("/auth/refresh")) return state.refresh();
        return state.guarded();
    };

    const axiosMock: any = makeAxios();
    // `api.ts` calls bare `axios.get` for the token and bare `axios.post` for
    // the refresh, so the instance's helpers are replaced with the bare path.
    axiosMock.get = (url: string, config: any = {}) => bare("get", url, undefined, config);
    axiosMock.post = (url: string, data?: unknown, config: any = {}) =>
        bare("post", url, data, config);
    axiosMock.create = () => makeAxios();

    return { default: axiosMock, ...axiosMock };
});

describe("api client session refresh", () => {
    beforeEach(() => {
        state.calls = [];
        state.refresh = async () => ({ status: 200, data: { status: "success" } });
        state.guarded = async () => ({ status: 200, data: { status: "success" } });
    });

    it("sends the CSRF token with mutating requests", async () => {
        const { default: api } = await import("@/lib/api");
        await api.post("/appointments", {});

        const post = state.calls.find((c) => c.url === "/appointments");
        expect(post?.headers["X-CSRF-Token"]).toBe(CSRF_TOKEN);
    });

    it("sends the CSRF token with the refresh call", async () => {
        // `/api/auth/refresh` is a mutating route and the server's CSRF guard
        // covers every mutating request under /api. A refresh without this
        // header gets a 403, and the whole single-flight path never engages.
        state.guarded = async () => {
            throw unauthorized();
        };

        const { default: api } = await import("@/lib/api");
        await expect(api.get("/users/profile")).rejects.toThrow();

        const refresh = state.calls.find((c) => c.url.includes("/auth/refresh"));
        expect(refresh).toBeDefined();
        expect(refresh?.headers["X-CSRF-Token"]).toBe(CSRF_TOKEN);
    });

    it("issues exactly one refresh for many parallel 401s", async () => {
        let authed = false;
        state.guarded = async () => {
            if (!authed) throw unauthorized();
            return { status: 200, data: { status: "success" } };
        };
        state.refresh = async () => {
            authed = true;
            return { status: 200, data: { status: "success" } };
        };

        const { default: api } = await import("@/lib/api");

        // A dashboard issues several requests at once; all of them expire
        // together when the access token lapses.
        const results = await Promise.all([
            api.get("/users/profile"),
            api.get("/appointments"),
            api.get("/messages"),
        ]);

        expect(countRefresh()).toBe(1);
        expect(results).toHaveLength(3);
        for (const result of results) {
            expect(result.status).toBe(200);
        }
    });

    it("replays a request at most once", async () => {
        // Even when the refreshed token is still rejected, a request must not
        // loop — otherwise a misconfigured server spins forever.
        state.guarded = async () => {
            throw unauthorized();
        };

        const { default: api } = await import("@/lib/api");
        await expect(api.get("/users/profile")).rejects.toThrow();

        const profileCalls = state.calls.filter((c) => c.url === "/users/profile");
        expect(profileCalls).toHaveLength(2);
        expect(countRefresh()).toBe(1);
    });

    it("does not refresh for public auth endpoints", async () => {
        state.guarded = async () => {
            throw unauthorized();
        };

        const { default: api } = await import("@/lib/api");
        await expect(api.post("/auth/login", {})).rejects.toThrow();

        expect(countRefresh()).toBe(0);
    });
});
