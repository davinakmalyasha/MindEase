import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    timeout: 60_000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:3000",
        trace: "retain-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: [
        {
            command: "npx ts-node src/index.ts",
            cwd: "../server",
            url: "http://localhost:5000/api/health",
            reuseExistingServer: true,
            timeout: 60_000,
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
