import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    test: {
        environment: "node",
        globalSetup: ["./tests/global-setup.ts"],
        setupFiles: ["./tests/setup.ts"],
        include: ["tests/**/*.test.ts"],

        /**
         * These are integration tests against a real MySQL, with no mocking of
         * the database or the service layer — deliberately, so auth is exercised
         * through real Argon2 and real cookies. Several tests perform six or more
         * password hashes plus a full 27-table wipe in `beforeEach` *and*
         * `afterEach`.
         *
         * Vitest's 30s default is sized for unit tests and is simply too small
         * here: on a loaded machine the 2FA backup-code test exceeded it and
         * failed on a timeout rather than on anything about 2FA. Two separate
         * security tests were failing for that reason, which is worse than no
         * coverage at all.
         */
        testTimeout: 120_000,
        hookTimeout: 120_000,

        pool: "forks",
        fileParallelism: false,

        /**
         * Coverage, available but not required.
         *
         * `npm run coverage` produces an HTML report under
         * `server/coverage/`. It is not wired into `npm test`, because the
         * suite is 488 integration tests against a real MySQL and the v8
         * instrumentation overhead on top of that is not something to pay on
         * every run to produce a number that changes on its own.
         *
         * No thresholds, deliberately. A coverage gate added at the same moment
         * as a first coverage run is a number nobody has looked at yet, and this
         * codebase would fail it by a wide margin - which would then get
         * "fixed" by adding exclusions. `docs/roadmap.md` tracks it.
         */
        coverage: {
            provider: "v8",
            reportsDirectory: "coverage",
            reporter: ["text-summary", "html", "lcov"],
            // Tests are not the subject; measuring them tells you how many
            // assertions exist, which is a different and much less useful number.
            exclude: ["tests/**", "**/*.d.ts", "dist/**", "prisma/**", "node_modules/**"],
            all: true,
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
