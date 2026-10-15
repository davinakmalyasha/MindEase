import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    // 60s was enough for every journey except the two that build their own
    // fixtures end to end (Journey 1 books; Journey 10 books, completes, reviews,
    // replies and reports). Those were failing on the clock while blocked on a
    // covered button, so the extra headroom is not masking a hang - it is so a
    // slow-but-correct run on a loaded machine does not time out mid-wizard.
    timeout: 90_000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:3000",
        trace: "retain-on-failure",
        // Grant notifications so `Notification.permission` is "granted" and the
        // "Enable notifications?" prompt never renders. That prompt is a fixed
        // banner in the bottom-right corner and it covers the booking modal's
        // controls; a test should not fight a modal for the corner of the page.
        // Granting the permission is what a returning user who accepted it
        // looks like, so this is a real user state, not a bypass.
        permissions: ["notifications"],
        // Answer the cookie consent prompt before it can render. The banner is
        // fixed at the bottom-left and, at `z-[80]`, covered the booking
        // modal's Back button - which is how Journey 1 and Journey 10 timed
        // out. `Dialog` now outranks it, but seeding consent is what a
        // returning user looks like and keeps passive chrome out of the way.
        storageState: {
            cookies: [],
            origins: [
                {
                    origin: "http://localhost:3000",
                    localStorage: [
                        { name: "mindease-cookie-consent", value: "accepted" },
                    ],
                },
            ],
        },
    },
    projects: [
        {
            // One sign-in per seeded role, reused by the journeys that need it.
            //
            // Each journey used to sign in for itself: twelve logins plus four
            // registrations from one IP, against an API enforcing its real
            // production limits, which is how the later journeys started failing
            // on 429s. See `e2e/auth.setup.ts`.
            name: "setup",
            testMatch: /auth\.setup\.ts/,
        },
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
            dependencies: ["setup"],
        },
    ],
    webServer: [
        {
            command: "npx ts-node src/index.ts",
            cwd: "../server",
            url: "http://localhost:5000/api/health",
            reuseExistingServer: true,
            // A cold `ts-node` start type-checks the whole server before the
            // first request, and on a slow dev machine that measured 119s -
            // past the old 60s, which failed the run before a browser opened.
            // CI builds once and boots from that, so this only ever applies
            // locally.
            timeout: 180_000,
        },
        {
            command: "npm run dev -- --port 3000",
            cwd: ".",
            url: "http://localhost:3000",
            reuseExistingServer: true,
            timeout: 120_000,
        },
    ],
});
