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
         * Coverage.
         *
         * `npm run coverage` produces an HTML report under `server/coverage/`
         * and is not part of `npm test` - the v8 instrumentation overhead on top
         * of an integration suite against a real MySQL is not something to pay
         * on every local run.
         *
         * ## Thresholds
         *
         * The baseline has been read: 73.99% statements, 55.64% branches,
         * 76.55% functions, 76.8% lines. The floors below sit just under it, so
         * ordinary churn does not flake the gate while a real regression does.
         * They are floors, not targets: raise them when the number is earned,
         * never lower them to make a run pass. CI enforces them on main and the
         * weekly run, where the suite already pays for coverage.
         */
        coverage: {
            provider: "v8",
            reportsDirectory: "coverage",
            reporter: ["text-summary", "html", "lcov"],
            thresholds: {
                statements: 73,
                branches: 55,
                functions: 75,
                lines: 76,
            },
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
