import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Signs in once per seeded role and saves the session for the journeys to reuse.
 *
 * ## Why this exists
 *
 * The journeys each signed in for themselves, which is twelve logins plus four
 * registrations from one IP. The API enforces its real production limits here -
 * the e2e stack runs with `NODE_ENV=production`, and only the *server* suite
 * bypasses them (`skipInTest`) - so the later journeys started failing on HTTP
 * 429s. Twelve journeys is far more auth traffic than a person generates in a
 * quarter of an hour, so the suite was shaped wrongly for the limits rather than
 * the other way round.
 *
 * Relaxing a security control so that a test passes would be the wrong repair.
 * This is the right one: three sign-ins, cached, reused.
 *
 * A session here is a cookie pair plus the `mindease:user` entry in
 * localStorage, and `storageState` captures both, so a reused state is
 * indistinguishable from having signed in.
 */

const AUTH_DIR = path.join(__dirname, "..", ".auth");

const ROLES = [
    { name: "patient", email: "patient@mindease.app", password: "Patient@123" },
    { name: "doctor", email: "dr1@mindease.app", password: "Doctor@123" },
    { name: "admin", email: "admin@mindease.app", password: "Admin@123" },
];

setup.beforeAll(() => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
});

for (const role of ROLES) {
    setup(`authenticate as ${role.name}`, async ({ page }) => {
        await page.goto("/login");
        await page.getByLabel("Email").fill(role.email);
        await page.getByLabel("Password").fill(role.password);
        await page.getByRole("button", { name: "Sign In" }).click();

        // Waits for the post-login navigation, which the app performs with
        // `window.location.href`. Returning before it settles is what made the
        // journeys' next `page.goto` abort with `net::ERR_ABORTED`.
        await expect(page).toHaveURL(/dashboard/, { timeout: 20_000 });

        await page.context().storageState({ path: path.join(AUTH_DIR, `${role.name}.json`) });
    });
}
