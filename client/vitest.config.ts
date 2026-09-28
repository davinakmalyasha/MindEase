import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./vitest.setup.ts"],
        include: ["tests/**/*.test.{ts,tsx}"],
        // The session code manipulates module-level singletons, so files must
        // not share a module registry.
        isolate: true,
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "."),
        },
    },
});
