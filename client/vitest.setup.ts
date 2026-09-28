/**
 * jsdom does not implement these, and several modules touch them on import.
 * Stubbing them keeps failures in the code under test rather than in the shims.
 */

if (typeof globalThis.crypto === "undefined" || !("randomUUID" in globalThis.crypto)) {
    Object.defineProperty(globalThis, "crypto", {
        value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
        configurable: true,
    });
}

if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        }),
    });
}
