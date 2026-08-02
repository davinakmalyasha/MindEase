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
        const doctorId = 2; // Dr. Sarah Mitchell (seeded with slots)
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
