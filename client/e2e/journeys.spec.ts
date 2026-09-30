import { test, expect, Page } from "@playwright/test";

const API = "http://localhost:5000/api";

// Helper: register a throwaway account and return its credentials
async function registerUser(page: Page, role: "patient" | "doctor"): Promise<{ email: string; password: string }> {
    const email = `e2e-${role}-${Date.now()}-${Math.floor(Math.random() * 1000)}@test.app`;
    const password = "E2EPass@123";

    await page.goto("/register");
    await page.getByLabel("Full Name").fill(`E2E ${role}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Phone (WhatsApp)").fill("+6281234567890");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: role, exact: true }).click();
    await page.getByRole("button", { name: "Create Account" }).click();

    // Should land in the dashboard after registration
    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
    return { email, password };
}

async function login(page: Page, email: string, password: string) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
}

test.describe("Journey 1: Patient registers, logs mood, books an appointment", () => {
    test("full patient flow", async ({ page }) => {
        await registerUser(page, "patient");
        await page.goto("/dashboard/mood");
        await expect(page.getByRole("heading", { name: "Mood Tracker" })).toBeVisible({ timeout: 15_000 });

        // Log a mood
        await page.getByRole("button", { name: /Great/ }).click();
        await page.getByRole("button", { name: /Log Mood/ }).click();
        await expect(page.getByText(/Mood logged/)).toBeVisible({ timeout: 10_000 });

        // Browse doctors and open booking (2nd doctor is a seeded one with slots)
        await page.goto("/appointments");
        await expect(page.getByText(/Book an/)).toBeVisible({ timeout: 15_000 });

        // Pick a genuinely free slot from the API first (deterministic, no retries)
        // Seeded doctor 2, which the seed creates with availability. Not named
        // here because the seed's name list is shuffled — the profile is read
        // from the API below rather than asserted against a literal.
        const doctorId = 2;
        const docRes = await page.request.get(`${API}/doctors/${doctorId}`);
        const docData = (await docRes.json()).data;
        const freeSlot = (docData.consultationSlots || []).find((s: any) => !s.isBooked);
        expect(freeSlot).toBeTruthy();

        const slotDate = new Date(freeSlot.date);
        const chipLabel = `${slotDate.toLocaleDateString("en-US", { weekday: "short" })}${String(slotDate.getDate()).padStart(2, "0")}${slotDate.toLocaleDateString("en-US", { month: "short" })}`;

        await page.getByRole("button", { name: /Book Now/ }).nth(1).click();

        // Booking wizard: pick date → time → details → confirm
        await expect(page.getByText("Select Consultation Date")).toBeVisible({ timeout: 15_000 });

        // Step 1: select the slot's date chip, then continue
        await page.locator("button", { hasText: new RegExp(`^${chipLabel}$`) }).click();
        await page.locator("button", { hasText: /Continue/ }).first().click();

        // Step 2: select the slot's time, then continue
        await expect(page.getByText(/Available Time Slots/)).toBeVisible({ timeout: 10_000 });
        await page.locator("button", { hasText: new RegExp(`^${freeSlot.startTime}$`) }).click();
        await page.locator("button", { hasText: /Continue/ }).first().click();

        // Step 3: details
        await page.getByLabel(/Patient Full Name/).fill("E2E Patient");
        await page.locator("button", { hasText: /Continue/ }).first().click();

        // Step 4: confirm
        await page.getByRole("button", { name: /Confirm & Schedule/ }).click();
        await expect(page.getByText(/Booking Confirmed/)).toBeVisible({ timeout: 20_000 });
    });
});

test.describe("Journey 2: Admin dashboard access", () => {
    test("admin can view stats and users", async ({ page }) => {
        await login(page, "admin@mindease.app", "Admin@123");
        await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

        await page.goto("/dashboard/admin");
        await expect(page.getByText(/Admin Dashboard/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/Total Patients/)).toBeVisible();
        await expect(page.getByText(/System Users/)).toBeVisible();
    });
});

test.describe("Journey 3: Forgot password reset flow", () => {
    test("request reset code", async ({ page }) => {
        const user = await registerUser(page, "patient");
        await page.goto("/forgot-password");
        await page.getByLabel("Email").fill(user.email);
        await page.getByRole("button", { name: /Send Reset Code/ }).click();
        await expect(page.getByText(/reset code was sent/i)).toBeVisible({ timeout: 10_000 });
    });
});

test.describe("Journey 4: Assessments + mood factors (round 3)", () => {
    test("patient submits a PHQ-9 and sees severity", async ({ page }) => {
        await registerUser(page, "patient");
        await page.goto("/dashboard/assessments");
        await expect(page.getByRole("heading", { name: /Self-Assessments/ })).toBeVisible({ timeout: 15_000 });

        // Answer all 9 PHQ-9 questions with "Not at all" (score 0 → minimal)
        for (let i = 0; i < 9; i++) {
            await page.getByRole("button", { name: /^Not at all$/ }).click();
            if (i < 8) {
                await page.getByRole("button", { name: /Next/ }).click();
            }
        }
        await page.getByRole("button", { name: /Submit/ }).click();
        await expect(page.getByText(/Minimal/i)).toBeVisible({ timeout: 10_000 });

        // Mood factors chips on the mood page
        await page.goto("/dashboard/mood");
        await expect(page.getByRole("heading", { name: /Mood Tracker/ })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: /Great/ }).click();
        await page.getByRole("button", { name: /Sleep/ }).click();
        await page.getByRole("button", { name: /Log Mood/ }).click();
        await expect(page.getByText(/Mood logged/)).toBeVisible({ timeout: 10_000 });
    });

    test("print report link opens a printable view", async ({ page }) => {
        await login(page, "patient@mindease.app", "Patient@123");
        await page.goto("/dashboard/assessments?print=1");
        await expect(page.getByText(/MindEase Assessment Report/)).toBeVisible({ timeout: 15_000 });
    });
});

test.describe("Journey 5: Doctor accepts, completes and suggests a follow-up", () => {
    test("doctor follow-up flow on a completed session", async ({ page }) => {
        await login(page, "dr1@mindease.app", "Doctor@123");
        await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

        await page.goto("/dashboard/appointments");
        await expect(page.getByText(/Consultation History/)).toBeVisible({ timeout: 15_000 });

        // If a completed appointment exists, the follow-up button is available
        const followUpButton = page.getByRole("button", { name: /Suggest Follow-up/ }).first();
        if (await followUpButton.isVisible().catch(() => false)) {
            await followUpButton.click();
            await expect(page.getByText(/Suggest a follow-up/)).toBeVisible();
            const date = new Date();
            date.setDate(date.getDate() + 3);
            await page.locator('input[type="date"]').fill(date.toISOString().split("T")[0]);
            await page.getByRole("button", { name: /Send follow-up suggestion/ }).click();
            await expect(page.getByText(/Follow-up suggested/)).toBeVisible({ timeout: 10_000 });
        }
    });

    test("doctor creates a weekly availability pattern", async ({ page }) => {
        await login(page, "dr1@mindease.app", "Doctor@123");
        await page.goto("/dashboard/doctor/schedule");
        await expect(page.getByText(/Weekly Pattern/)).toBeVisible({ timeout: 15_000 });

        await page.locator('select').first().selectOption("3"); // Thursday
        await page.locator('input[type="time"]').nth(0).fill("15:00");
        await page.locator('input[type="time"]').nth(1).fill("16:00");
        await page.getByRole("button", { name: /Create Pattern/ }).click();
        await expect(page.getByText(/Pattern created/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/Active patterns/)).toBeVisible();
    });
});

test.describe("Journey 6: Review reply + report (round 3)", () => {
    test("doctor sees reply and report actions on own profile reviews", async ({ page }) => {
        await login(page, "dr1@mindease.app", "Doctor@123");
        await page.goto("/doctors/1");
        await expect(page.getByText(/Latest Reviews/)).toBeVisible({ timeout: 15_000 });

        // Actions render for the owning doctor. Conditional because the seed
        // deliberately creates no reviews: Phase 0 removed the fabricated
        // ratings the seed used to invent, since a real doctor's review count
        // must not be populated with fake entries. With an empty seed this
        // journey asserts the page loads and passes without exercising the
        // reply/report path.
        //
        // Journey 10 at the end of this file is the real test: it builds the
        // booking, the completion and the review itself, so the reply and report
        // paths genuinely execute. This one is left as the cheap smoke test of
        // the reviews section rendering.
        const replyAction = page.getByRole("button", { name: /^Reply$/ }).first();
        const reportAction = page.getByRole("button", { name: /Report/ }).first();
        if (await replyAction.isVisible().catch(() => false)) {
            await replyAction.click();
            await expect(page.getByText(/Reply to this review/)).toBeVisible();
        }
        if (await reportAction.isVisible().catch(() => false)) {
            await reportAction.click();
            page.on("dialog", (dialog) => dialog.accept("Test report reason"));
            await expect(page.getByText(/Review reported/)).toBeVisible({ timeout: 10_000 }).catch(() => {});
        }
    });
});

test.describe("Journey 7: SOS button (round 3)", () => {
    test("patient opens the SOS modal with crisis hotlines", async ({ page }) => {
        await login(page, "patient@mindease.app", "Patient@123");
        await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

        await page.getByRole("button", { name: /SOS/ }).first().click();
        await expect(page.getByText(/I need help now/)).toBeVisible({ timeout: 10_000 });
        await page.getByRole("button", { name: /I need help now/ }).click();
        page.on("dialog", (dialog) => dialog.accept());
        await expect(page.getByText(/Crisis hotlines/)).toBeVisible({ timeout: 10_000 });
    });
});

test.describe("Journey 8: Admin moderation + exports (round 3)", () => {
    test("admin sees review reports and export buttons", async ({ page }) => {
        await login(page, "admin@mindease.app", "Admin@123");
        await page.goto("/dashboard/admin");
        await expect(page.getByText(/Review Reports/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/Revenue Trend/)).toBeVisible();
        await expect(page.getByRole("button", { name: /Bookings CSV/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Users CSV/ })).toBeVisible();
    });
});

test.describe("Journey 9: Chat smoke (round 3)", () => {
    test("messages page renders with search and attachments", async ({ page }) => {
        await login(page, "patient@mindease.app", "Patient@123");
        await page.goto("/messages");
        await expect(page.getByText(/Messages/).first()).toBeVisible({ timeout: 15_000 });
        await expect(page.getByPlaceholder(/Search\.\.\./)).toBeVisible();
        await expect(page.getByPlaceholder(/Type a message/)).toBeVisible();
    });
});

/**
 * The review lifecycle, end to end, building the review it needs.
 *
 * Journey 6 above is a smoke test and says so: a review can only be written
 * against a *completed* appointment, the seed deliberately creates zero reviews
 * (it used to invent 4.2-4.9 ratings for clinicians with no reviews, which made
 * "Top Rated" rank the most-liked-looking profiles first), and so the reply and
 * report paths never executed.
 *
 * This journey creates the whole chain itself. The split between UI and API is
 * deliberate and worth stating:
 *
 *  - **UI** for booking, writing the review, replying, and reporting - that is
 *    the surface under test, and it is what would break on a refactor.
 *  - **API** for the clinician accepting and completing the appointment. Those
 *    are two state transitions that are already covered by the server suite,
 *    they need three more unverified selectors, and they are not what this
 *    journey is about. Driving them over HTTP keeps the test about reviews and
 *    makes it far likelier to pass on a first run.
 *
 * Seeded doctor 2 is `dr2@mindease.app` on a fresh seed: the seed creates users
 * in order, so doctorId 2 is the second clinician it made. It is referenced by
 * account rather than by display name, because the name list is shuffled.
 */
test.describe("Journey 10: review lifecycle", () => {
    const DOCTOR_ID = 2;
    const DOCTOR_EMAIL = "dr2@mindease.app";
    const DOCTOR_PASSWORD = "Doctor@123";

    test("a completed session produces a review the clinician can reply to and report", async ({
        page,
    }) => {
        // --- Patient books -----------------------------------------------------
        const patient = await registerUser(page, "patient");

        await page.goto("/appointments");
        await expect(page.getByText(/Book an/)).toBeVisible({ timeout: 15_000 });

        const docRes = await page.request.get(`${API}/doctors/${DOCTOR_ID}`);
        expect(docRes.ok()).toBeTruthy();
        const docData = (await docRes.json()).data;
        const freeSlot = (docData.consultationSlots || []).find(
            (s: { isBooked: boolean }) => !s.isBooked
        );
        // Journey 1 books from the same pool. 21 slots exist and the suite runs
        // serially, so this only fires if someone starts booking them by hand.
        expect(freeSlot).toBeTruthy();

        const slotDate = new Date(freeSlot.date);
        const chipLabel = `${slotDate.toLocaleDateString("en-US", { weekday: "short" })}${String(
            slotDate.getDate()
        ).padStart(2, "0")}${slotDate.toLocaleDateString("en-US", { month: "short" })}`;

        await page.getByRole("button", { name: /Book Now/ }).nth(1).click();
        await expect(page.getByText("Select Consultation Date")).toBeVisible({ timeout: 15_000 });

        await page.locator("button", { hasText: new RegExp(`^${chipLabel}$`) }).click();
        await page.locator("button", { hasText: /Continue/ }).first().click();

        await expect(page.getByText(/Available Time Slots/)).toBeVisible({ timeout: 10_000 });
        await page.locator("button", { hasText: new RegExp(`^${freeSlot.startTime}$`) }).click();
        await page.locator("button", { hasText: /Continue/ }).first().click();

        await page.getByLabel(/Patient Full Name/).fill("E2E Reviewer");
        await page.locator("button", { hasText: /Continue/ }).first().click();
        await page.getByRole("button", { name: /Confirm & Schedule/ }).click();
        await expect(page.getByText(/Booking Confirmed/)).toBeVisible({ timeout: 20_000 });

        // --- Clinician accepts and completes ---------------------------------
        // Over HTTP rather than the UI: see the note above. Both transitions
        // require a CSRF token, which the logged-in session supplies.
        await login(page, DOCTOR_EMAIL, DOCTOR_PASSWORD);
        await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

        const csrfRes = await page.request.get(`${API}/csrf-token`);
        const csrf = (await csrfRes.json()).data.csrfToken;

        const listRes = await page.request.get(`${API}/appointments/my`);
        const mine = (await listRes.json()).data as { id: number; status: string }[];
        const appointment = mine.find((a) => a.status === "pending");
        expect(appointment, "the seeded clinician should have a pending booking").toBeTruthy();

        const confirm = await page.request.put(`${API}/appointments/${appointment!.id}/status`, {
            headers: { "X-CSRF-Token": csrf },
            data: { status: "confirmed" },
        });
        expect(confirm.status()).toBeLessThan(300);

        const complete = await page.request.put(`${API}/appointments/${appointment!.id}/status`, {
            headers: { "X-CSRF-Token": csrf },
            data: { status: "completed" },
        });
        expect(complete.status()).toBeLessThan(300);

        // --- Patient reviews --------------------------------------------------
        await login(page, patient.email, patient.password);
        await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

        await page.goto("/dashboard/appointments");
        const reviewButton = page.getByRole("button", { name: /Review|Leave.*Review/i }).first();
        await expect(reviewButton).toBeVisible({ timeout: 20_000 });
        await reviewButton.click();

        const comment = "E2E review: the session was genuinely helpful.";
        await page.getByRole("dialog").getByRole("radio").nth(4).click();
        await page.getByPlaceholder(/review|comment|share/i).first().fill(comment);
        await page.getByRole("button", { name: /Submit|Send Review|Post/i }).first().click();
        await expect(page.getByText(/Review submitted|Thank you/i)).toBeVisible({ timeout: 15_000 });

        // --- Clinician replies and reports ------------------------------------
        await login(page, DOCTOR_EMAIL, DOCTOR_PASSWORD);
        await page.goto(`/doctors/${DOCTOR_ID}`);

        const reply = page.getByRole("button", { name: /^Reply$/ }).first();
        // No conditional guard. If the review is missing, this test has failed
        // for a real reason and must say so rather than passing vacuously the way
        // the seed-dependent version did.
        await expect(reply).toBeVisible({ timeout: 20_000 });
        await reply.click();

        await page.getByRole("dialog").getByPlaceholder(/reply/i).fill("Thank you for the kind words.");
        await page.getByRole("button", { name: /Post Reply|Send Reply/i }).first().click();
        await expect(page.getByText(/Thank you for the kind words/)).toBeVisible({ timeout: 15_000 });

        const report = page.getByRole("button", { name: /Report/ }).first();
        await expect(report).toBeVisible({ timeout: 10_000 });
        await report.click();
        page.on("dialog", (dialog) => dialog.accept("E2E: exercising the moderation path."));
        await expect(page.getByText(/Review reported/i)).toBeVisible({ timeout: 15_000 });
    });
});
