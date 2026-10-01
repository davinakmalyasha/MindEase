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
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
