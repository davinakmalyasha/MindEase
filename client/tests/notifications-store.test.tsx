import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({
    listCalls: 0,
    countCalls: 0,
    listRows: [] as any[],
    unread: 0,
}));

vi.mock("@/lib/api", () => {
    const api: any = {
        get: (url: string) => {
            if (url.includes("unread-count")) {
                state.countCalls += 1;
                return Promise.resolve({ data: { data: { count: state.unread } } });
            }
            state.listCalls += 1;
            return Promise.resolve({
                data: { data: { rows: state.listRows, totalPages: 1 } },
            });
        },
        patch: () => Promise.resolve({ data: {} }),
    };
    return { default: api, getErrorMessage: (e: unknown, fallback: string) => fallback };
});

/** Drains the microtask queue; safe under fake timers (no macrotask waits). */
const flush = async () => {
    await act(async () => {
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
};

describe("shared notification store", () => {
    beforeEach(() => {
        state.listCalls = 0;
        state.countCalls = 0;
        state.listRows = [
            { id: 1, title: "First", message: "m", isRead: false, type: null, createdAt: "2026-01-01T00:00:00Z" },
        ];
        state.unread = 1;
    });

    afterEach(() => {
        // The store is a module singleton, so a hook left mounted would keep
        // its subscription — and its polling interval — alive into the next test.
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("fetches once for many subscribers", async () => {
        // The bell is mounted three times (Navbar, and twice in the dashboard
        // layout). Independent state per copy meant three pollers that could
        // disagree on the unread count.
        const { useNotifications } = await import("@/hooks/useNotifications");
        const { renderHook } = await import("@testing-library/react");

        const a = renderHook(() => useNotifications(30000));
        const b = renderHook(() => useNotifications(30000));
        const c = renderHook(() => useNotifications(15000));

        await flush();

        expect(state.listCalls).toBe(1);
        expect(state.countCalls).toBe(1);

        // All three see the same value.
        expect(a.result.current.unreadCount).toBe(1);
        expect(b.result.current.unreadCount).toBe(1);
        expect(c.result.current.unreadCount).toBe(1);
        expect(a.result.current.notifications).toBe(b.result.current.notifications);
    });

    it("polls on a single interval regardless of subscriber count", async () => {
        vi.useFakeTimers();
        const { useNotifications } = await import("@/hooks/useNotifications");
        const { renderHook } = await import("@testing-library/react");

        renderHook(() => useNotifications(15000));
        renderHook(() => useNotifications(30000));
        renderHook(() => useNotifications(30000));

        await flush();
        const afterMount = state.listCalls;

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        // One tick, not three.
        expect(state.listCalls - afterMount).toBe(1);
    });

    it("refreshes when the socket announces a new notification", async () => {
        const { useNotifications } = await import("@/hooks/useNotifications");
        const { renderHook } = await import("@testing-library/react");

        renderHook(() => useNotifications(0));
        await flush();
        const before = state.listCalls;

        await act(async () => {
            window.dispatchEvent(new CustomEvent("realtime:notification"));
        });
        await flush();

        expect(state.listCalls).toBe(before + 1);
    });

    it("does not poll a hidden tab", async () => {
        vi.useFakeTimers();
        const { useNotifications } = await import("@/hooks/useNotifications");
        const { renderHook } = await import("@testing-library/react");

        renderHook(() => useNotifications(10000));
        await flush();
        const afterMount = state.listCalls;

        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30000);
        });
        expect(state.listCalls).toBe(afterMount);
    });
});
