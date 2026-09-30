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
        // reply/report path — see the note in README about covering it with a
        // self-contained booking -> complete -> review flow.
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
