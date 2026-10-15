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

/**
 * Picks the first date in the booking modal that has an open time, and that time.
 *
 * ## Why this walks the dates instead of computing one
 *
 * It used to read `/doctors/:id`, take the first free slot, and click the chip
 * whose date that was. That endpoint is cached for two minutes, which is about
 * the length of a suite run, so its answer goes stale: Journey 10 waited for
 * 09:00 because the cached response still called it free, after Journey 1 had
 * booked it.
 *
 * `BookingModal` now derives `DatePicker`'s `availableDates` from the slot list
 * it fetched, so chips for days with nothing open are disabled and the walk
 * below normally exits on its first iteration. It stays because the modal's
 * list was fetched moments earlier and a slot can be taken in between; the walk
 * is the cheap recovery.
 *
 * Only enabled chips are walked, for the same reason. The date chips render the
 * three parts of a date concatenated - "Thu", "15", "Oct" - so their text is
 * `Thu15Oct`.
 */
async function pickFirstOfferedSlot(page: Page) {
    const goBack = page.getByRole("button", { name: /^Back$/ });
    const proceed = page.locator("button", { hasText: /Continue/ }).first();
    const chips = page
        .locator("button:enabled")
        .filter({ hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}[A-Z][a-z]{2}$/ });
    const times = page.locator("button").filter({ hasText: /^\d{2}:\d{2}$/ });
    const noSlots = page.getByText("No open slots for this day");

    const days = await chips.count();
    for (let i = 0; i < days; i += 1) {
        await chips.nth(i).click();
        await proceed.click();

        // The wizard swaps steps with an exit animation (`AnimatePresence
        // mode="wait"` in `BookingModal`), so for a beat after Continue the old
        // panel is still mounted and none of step 2's controls exist yet.
        // `count()` does not retry, and this walk counted in exactly that window
        // and read zero for every date: it pressed Back through all seven
        // enabled dates of doctor 7 while the trace's DOM snapshots show
        // 08:00/09:00/10:00 rendered each time.
        //
        // Waiting on the step-2 content itself - a time chip, or the empty state
        // the panel renders in its place - is waiting for the swap to have
        // happened. The "Step 2 of 4 in progress" marker cannot be used for
        // this: it lives in the static progress list and appears with the state
        // change, before the animated panel has mounted.
        await expect(times.first().or(noSlots)).toBeVisible({ timeout: 5_000 });

        if ((await times.count()) > 0) {
            await times.first().click();
            await page.locator("button", { hasText: /Continue/ }).first().click();
            return;
        }

        await goBack.click();
    }

    throw new Error("no date in the picker offered an open slot");
}

async function login(page: Page, email: string, password: string) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();

    // Wait for the post-login navigation to settle before returning.
    //
    // The app redirects with `window.location.href`, so the click resolves while
    // a navigation is still in flight. A caller that immediately called
    // `page.goto(...)` had that navigation aborted by the pending one, which
    // surfaced as `net::ERR_ABORTED` on the *next* URL and an empty page
    // snapshot - reading like the destination is broken rather than like the
    // test raced the redirect. Three journeys failed that way.
    await expect(page).toHaveURL(/dashboard/, { timeout: 20_000 });
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

        await page.getByRole("button", { name: /Book Now/ }).nth(1).click();

        // Booking wizard: pick date → time → details → confirm
        await expect(page.getByText("Select Consultation Date")).toBeVisible({ timeout: 15_000 });
        await pickFirstOfferedSlot(page);

        // Step 3: details
        await page.getByLabel(/Patient Full Name/).fill("E2E Patient");
        await page.locator("button", { hasText: /Continue/ }).first().click();

        // Step 4: confirm
        // Case-insensitive: the button reads "Confirm & schedule", and this
        // expectation was written as "Confirm & Schedule" against a UI that has
        // never been run alongside it. Playwright's regex matching is
        // case-sensitive, so the journey timed out waiting for a button that was
        // on screen the whole time.
        await page.getByRole("button", { name: /Confirm & schedule/i }).click();
        // Case-insensitive for the same reason as the button above: the dialog
        // title is "Booking confirmed", and this looked for "Booking Confirmed".
        // The booking had already succeeded by the time this timed out - the
        // failure snapshot shows the dialog open with the confirmation in it.
        await expect(page.getByText(/Booking confirmed/i)).toBeVisible({ timeout: 20_000 });
    });
});

test.describe("Journey 2: Admin dashboard access", () => {
    // Session cached by `auth.setup.ts` rather than signed in here. The journey
    // is about the dashboard rendering for an admin, and signing in over the UI
    // is exercised by the journeys that need a fresh account anyway.
    test.use({ storageState: ".auth/admin.json" });

    test("admin can view stats and users", async ({ page }) => {
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

        // The score heading is unique to the result block: a PHQ-9 answered
        // entirely "Not at all" is "0 / 27", and nothing else on the page says
        // that. Asserting on the severity alone is a strict-mode violation - the
        // result badge, the trajectory chart's data point, that chart's legend
        // and its axis all name a severity - which is what the suite's first run
        // reported.
        await expect(page.getByRole("heading", { name: "0 / 27" })).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText("Minimal", { exact: true }).first()).toBeVisible();

        // Mood factors chips on the mood page
        await page.goto("/dashboard/mood");
        await expect(page.getByRole("heading", { name: /Mood Tracker/ })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: /Great/ }).click();
        await page.getByRole("button", { name: /Sleep/ }).click();
        await page.getByRole("button", { name: /Log Mood/ }).click();
        await expect(page.getByText(/Mood logged/)).toBeVisible({ timeout: 10_000 });
    });
});

test.describe("Journey 4b: Assessment report print view", () => {
    // The seeded patient, from the cached session. This one lives apart from
    // the PHQ-9 test above because that test *registers* an account, and a
    // describe-level `storageState` would hand it a signed-in context it does
    // not expect.
    test.use({ storageState: ".auth/patient.json" });

    test("print report link opens a printable view", async ({ page }) => {
        await page.goto("/dashboard/assessments?print=1");
        await expect(page.getByText(/MindEase Assessment Report/)).toBeVisible({ timeout: 15_000 });
    });
});

test.describe("Journey 5: Doctor accepts, completes and suggests a follow-up", () => {
    test.use({ storageState: ".auth/doctor.json" });

    test("doctor follow-up flow on a completed session", async ({ page }) => {
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
        await page.goto("/dashboard/doctor/schedule");
        await expect(page.getByText(/Weekly Pattern/)).toBeVisible({ timeout: 15_000 });

        // By label, not by position.
        //
        // `page.locator('input[type="time"]').nth(0)` and `.nth(1)` were the first
        // two time inputs on the page, which belong to the "add a slot" form - so
        // the pattern's own times stayed empty, the request failed `hhmm`
        // validation, and the journey waited for a "Pattern created" toast that
        // could not arrive. The fields had no `id` or `htmlFor` at all, which is
        // also what made them position-only: unlabelled inputs announce nothing
        // useful to a screen reader.
        await page.getByLabel("Day").selectOption({ label: "Thursday" });
        await page.getByLabel("Start").fill("15:00");
        await page.getByLabel("End").fill("16:00");
        await page.getByRole("button", { name: /Create Pattern/ }).click();
        await expect(page.getByText(/Pattern created/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/Active patterns/)).toBeVisible();
    });
});

test.describe("Journey 6: Reviews section smoke (round 3)", () => {
    test.use({ storageState: ".auth/doctor.json" });

    test("own profile renders the reviews section for the owning clinician", async ({ page }) => {
        await page.goto("/doctors/1");
        await expect(page.getByText(/Latest Reviews/)).toBeVisible({ timeout: 15_000 });

        // The seed deliberately creates zero reviews - it used to invent 4.2-4.9
        // ratings for clinicians with no reviews, which made "Top Rated" rank the
        // most-liked-looking profiles first - so the honest assertion here is the
        // empty state. The reply and report controls render on reviews, and
        // exercising them needs one; Journey 10 builds the whole chain (booking,
        // completion, review) and drives reply and report for real.
        //
        // This block used to click a Reply button that cannot exist against an
        // empty seed, and registered its `dialog` handler after the click that
        // would have fired one - so it looked like it covered reply and report
        // while covering neither.
        await expect(page.getByText(/No reviews yet/i)).toBeVisible();
    });
});

test.describe("Journey 7: SOS button (round 3)", () => {
    test.use({ storageState: ".auth/patient.json" });

    test("patient opens the SOS modal with crisis hotlines", async ({ page }) => {
        // Patients land on `/dashboard/mood` when they sign in, and the SOS
        // button only exists on the dashboard itself, so this navigates
        // explicitly. The original version asserted on the post-login URL -
        // which the mood page also satisfies, since it is under `/dashboard` -
        // and then waited for a control that was never on screen, which read
        // like a missing SOS button rather than a missing navigation.
        await page.goto("/dashboard");

        await page.getByRole("button", { name: /SOS/ }).first().click();

        // The dialog's title is "SOS — I need help now" and its confirm button is
        // "Alert my doctor". This clicked a *button* named /I need help now/,
        // which is the title - so it waited for a control that does not exist
        // while the one it wanted was on screen.
        await expect(page.getByText(/I need help now/)).toBeVisible({ timeout: 10_000 });
        await page.getByRole("button", { name: /Alert my doctor/i }).click();

        // No `dialog` handler: `open()` opens the modal directly, and there is no
        // `window.confirm` anywhere in the flow. The handler here was registered
        // after the click that would have fired one anyway, so it could never
        // have caught anything.
        await expect(page.getByText(/Crisis hotlines/)).toBeVisible({ timeout: 10_000 });
    });
});

test.describe("Journey 8: Admin moderation + exports (round 3)", () => {
    test.use({ storageState: ".auth/admin.json" });

    test("admin sees review reports and export buttons", async ({ page }) => {
        await page.goto("/dashboard/admin");
        await expect(page.getByText(/Review Reports/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/Revenue Trend/)).toBeVisible();
        await expect(page.getByRole("button", { name: /Bookings CSV/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Users CSV/ })).toBeVisible();
    });
});

test.describe("Journey 9: Chat smoke (round 3)", () => {
    test.use({ storageState: ".auth/patient.json" });

    test("messages page renders with search and attachments", async ({ page }) => {
        await page.goto("/messages");
        await expect(page.getByText(/Messages/).first()).toBeVisible({ timeout: 15_000 });

        // The seed creates no messages, and the search box and composer are part
        // of the conversation panel - so they cannot render here. This asserted
        // both placeholders, which is unreachable against a seeded database: the
        // seeded patient has no conversation, and a conversation requires a
        // confirmed appointment (`canChat`), which the seed does not create
        // either.
        //
        // So this asserts the empty state, which is what the seed actually
        // produces. Exercising the composer needs a journey that builds the
        // appointment and the message first, the way Journey 10 builds the review
        // it needs rather than assuming one exists.
        await expect(page.getByText(/No conversations yet/i)).toBeVisible();
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
 *
 * The booking goes through the directory's deep link (`?doctor=2`) instead of
 * clicking "Book Now" on the second card. Positional selection made this journey
 * depend on the admin-visible order of a list every seeded rating ties at 0, so
 * MySQL is free to return whatever its plan produces - and it does return
 * doctor 7 first on this database. The journey hardcodes dr2 as the clinician
 * who accepts and completes the booking, so which card was second decided
 * whether the rest of the journey could work at all.
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

        await page.goto(`/appointments?doctor=${DOCTOR_ID}`);
        await expect(page.getByText("Select Consultation Date")).toBeVisible({ timeout: 15_000 });
        await pickFirstOfferedSlot(page);

        await page.getByLabel(/Patient Full Name/).fill("E2E Reviewer");
        await page.locator("button", { hasText: /Continue/ }).first().click();
        // Case-insensitive, as in Journey 1: the UI reads "Confirm & schedule".
        await page.getByRole("button", { name: /Confirm & schedule/i }).click();
        await expect(page.getByText(/Booking confirmed/i)).toBeVisible({ timeout: 20_000 });

        // --- Clinician accepts and completes ---------------------------------
        // Over HTTP rather than the UI: see the note above. Both transitions
        // require a CSRF token, which the logged-in session supplies.
        await login(page, DOCTOR_EMAIL, DOCTOR_PASSWORD);
        await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

        const csrfRes = await page.request.get(`${API}/csrf-token`);
        const csrf = (await csrfRes.json()).data.csrfToken;

        const listRes = await page.request.get(`${API}/appointments/my`);
        // Paginated envelope: `{ data: { rows, total, page, totalPages } }`.
        // This read `.data` as the array itself and threw `mine.find is not a
        // function` - after the booking had already succeeded.
        const mine = ((await listRes.json()).data?.rows ?? []) as {
            id: number;
            status: string;
        }[];
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
        // The control is a star icon plus "Rate". This looked for
        // `/Review|Leave.*Review/i`, which the button has never said.
        const reviewButton = page.getByRole("button", { name: /^Rate$/ }).first();
        await expect(reviewButton).toBeVisible({ timeout: 20_000 });
        await reviewButton.click();

        const comment = "E2E review: the session was genuinely helpful.";
        // The rating is five native radios, each `sr-only` inside the label of
        // its star. The input's 1x1 box sits underneath the visible star, so
        // Playwright's hit-target check refuses to click the input itself -
        // the star intercepts. Clicking the label is what a user does and is
        // what activates the radio.
        const fiveStars = page.getByRole("radio", { name: /5 Excellent/ });
        await page.locator("label", { has: fiveStars }).click();
        await expect(fiveStars).toBeChecked();
        await page
            .getByRole("dialog")
            .getByPlaceholder(/Share your experience/)
            .fill(comment);
        await page.getByRole("dialog").getByRole("button", { name: /Submit Review/ }).click();
        await expect(page.getByText(/Review submitted/i)).toBeVisible({ timeout: 15_000 });

        // --- Clinician replies and reports ------------------------------------
        await login(page, DOCTOR_EMAIL, DOCTOR_PASSWORD);
        await page.goto(`/doctors/${DOCTOR_ID}`);

        const reply = page.getByRole("button", { name: /^Reply$/ }).first();
        // No conditional guard. If the review is missing, this test has failed
        // for a real reason and must say so rather than passing vacuously the way
        // the seed-dependent version did.
        await expect(reply).toBeVisible({ timeout: 20_000 });
        await reply.click();

        // The reply form is an inline panel in the review card, not a dialog.
        // The previous selectors looked for it inside `getByRole("dialog")` and
        // clicked a "Post Reply"/"Send Reply" button; the real button reads
        // "Publish Reply" and the placeholder is the translated
        // "Thank the patient and address their feedback professionally...".
        await page.getByPlaceholder(/Thank the patient/).fill("Thank you for the kind words.");
        await page.getByRole("button", { name: /Publish Reply/ }).click();
        // The card re-fetches the review list and renders the reply under it.
        await expect(page.getByText(/Thank you for the kind words/)).toBeVisible({ timeout: 15_000 });

        const report = page.getByRole("button", { name: /Report/ }).first();
        await expect(report).toBeVisible({ timeout: 10_000 });
        // Before the click. Reporting opens a native `prompt()`, and Playwright
        // auto-dismisses a dialog no listener is registered for - the previous
        // order registered this after `click()` had already fired and dismissed
        // it, so the reason was null and the request never happened.
        page.on("dialog", (dialog) => dialog.accept("E2E: exercising the moderation path."));
        await report.click();
        await expect(page.getByText(/Review reported/i)).toBeVisible({ timeout: 15_000 });
    });
});
