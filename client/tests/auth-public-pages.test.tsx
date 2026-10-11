import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * A logged-out visitor must be able to reach the public site.
 *
 * This is a regression test for a bug that made registration impossible: the
 * provider validated the session on every page load by calling
 * `GET /users/profile`, so a visitor with no session got a 401, the interceptor
 * tried a refresh, that failed too, and the failure was reported as a *session
 * expiry* - which redirects to `/login?expired=1`.
 *
 * The result was that `/`, `/register`, the clinician directory and the privacy
 * notice all bounced a first-time visitor to a login screen captioned "your
 * session expired", and the one page meant for people without an account could
 * not be opened. It was invisible until the Playwright journeys were run for the
 * first time, two of which passed only because they sign in as a seeded account
 * first.
 *
 * The assertion is deliberately on the *request*, not on the redirect: the
 * missing profile call is the cause, and asserting on `window.location` would
 * pass even if some other 401 later caused the same navigation.
 */

const calls: string[] = [];

const unauthorised = (url: string): Promise<never> => {
    calls.push(url);
    // Rejected on a timer rather than immediately. A synchronous rejection
    // settles before `renderHook` returns, so the provider's state update lands
    // outside `act` and React warns about it - which would be noise in the output
    // of every later run. A tick of latency also models the network this stands
    // in for.
    return new Promise((_, reject) =>
        setTimeout(
            () => reject(Object.assign(new Error("401"), { response: { status: 401 } })),
            0
        )
    );
};

vi.mock("@/lib/api", () => {
    const api = {
        get: (url: string) => unauthorised(url),
        post: (url: string) => unauthorised(url),
        put: () => Promise.reject(new Error("unused")),
        delete: () => Promise.reject(new Error("unused")),
    };
    return {
        default: api,
        getErrorMessage: (_e: unknown, fallback: string) => fallback,
        onSessionExpired: () => undefined,
    };
});

const STORAGE_KEY = "mindease:user";

// jsdom in this configuration does not expose `localStorage`, and the provider
// under test reads it. Shimmed here rather than in `vitest.setup.ts`, for the
// same reason that file gives for its own shims - so a failure lands in the code
// under test rather than in the environment - and because this is the only test
// that needs it.
if (!window.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
            key: (i: number) => [...store.keys()][i] ?? null,
            get length() {
                return store.size;
            },
        },
    });
}

const renderProvider = async () => {
    const { renderHook } = await import("@testing-library/react");
    const { AuthProvider, useAuth } = await import("@/context/AuthContext");
    return renderHook(() => useAuth(), {
        wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
};

/** Drains the microtask queue inside `act`, so the mount effect settles cleanly. */
const flush = async () => {
    const { act } = await import("@testing-library/react");
    await act(async () => {
        // A macrotask tick as well as microtasks: the mocked rejection settles
        // through a `.catch().finally()` chain, and the `setState` in that chain
        // lands after the microtask queue drains.
        await new Promise((r) => setTimeout(r, 0));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
};

describe("AuthProvider session validation", () => {
    beforeEach(() => {
        calls.length = 0;
        window.localStorage.clear();
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        window.localStorage.clear();
    });

    it("does not ask for a profile when there is no stored session", async () => {
        await renderProvider();
        await flush();

        expect(calls).not.toContain("/users/profile");
        expect(calls).toHaveLength(0);
    });

    it("asks for a profile when a stored session needs validating", async () => {
        // The other direction, so the assertion above cannot be satisfied by the
        // effect simply never running.
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 1, name: "Stored", role: "patient" }));

        const { result } = await renderProvider();
        const { waitFor } = await import("@testing-library/react");
        // Waiting on the observable end state rather than a fixed number of
        // ticks: the rejection settles through a promise chain, and this is what
        // keeps the resulting update inside `act`.
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(calls).toContain("/users/profile");
    });

    it("does not treat a missing session as an expired one", async () => {
        // With no stored user the request never happens, so nothing can report an
        // expiry. Asserted explicitly because the redirect was the visible
        // symptom, and a future change could reintroduce the fetch while hiding
        // the redirect elsewhere.
        await renderProvider();
        await flush();

        expect(calls.filter((c) => c.includes("refresh"))).toHaveLength(0);
        expect(calls.filter((c) => c.includes("profile"))).toHaveLength(0);
    });
});
