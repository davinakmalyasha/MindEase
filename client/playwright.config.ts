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
        // No `permissions: ["notifications"]` here, deliberately.
        //
        // It read as "the prompt never renders because the permission is
        // granted", but in this Chromium the grant resolves to *denied* - the
        // same value a plain headless context reports - so it changed nothing.
        // The prompt is kept out of the way by the product rule instead: it
        // renders only while the permission is "default", and asks for
        // something that can still be asked. See `PushPromptBanner`.
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
            // The API is the Go service. `scripts/dev.sh` loads `server/.env`
            // (both implementations share the signing secrets during the
            // transition) and runs `go run ./cmd/api`. In the Docker job the
            // compose stack is already serving this URL, so this only ever
            // applies locally.
            command: "bash scripts/dev.sh",
            cwd: "../server-go",
            url: "http://localhost:5000/api/health",
            reuseExistingServer: true,
            // A cold `go run` compiles the module before the first request;
            // the old ts-node note measured 119s on the same hardware, and
            // this budget covers either toolchain on a slow machine.
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
