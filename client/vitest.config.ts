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

        // `@vitest/coverage-v8` has been a dependency here since it was added and
        // was never referenced by any config or script. Wired up so the number
        // can be produced at all.
        //
        // No thresholds, and the same reasoning as the server: a gate added with
        // a first run is a number nobody has read yet. See docs/roadmap.md.
        coverage: {
            provider: "v8",
            reportsDirectory: "coverage",
            reporter: ["text-summary", "html", "lcov"],
            // The locale files are large data, not logic. Measuring them would
            // report a low percentage that says nothing about the client.
            exclude: [
                "tests/**",
                "**/*.d.ts",
                ".next/**",
                "messages/*.json",
                "public/**",
                "node_modules/**",
            ],
            all: true,
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "."),
        },
    },
});
