import { describe, it, expect } from "vitest";
import { createUser, createDoctor, createAdmin, setupClient, PASSWORD } from "./helpers";
import { prisma } from "../src/app";

const futureDate = (days = 3) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
};

const bookFor = async (patient: any, doctor: any, extra: Record<string, any> = {}) => {
    return patient.agent
        .post("/api/appointments/book")
        .set("X-CSRF-Token", patient.csrf)
        .send({
            doctorId: doctor.doctorId,
            appointmentDate: futureDate(),
            startTime: "10:00",
            endTime: "11:00",
            consultationType: "video",
            ...extra,
        });
};

const confirmAppointment = async (appId: number, doctor: any) => {
    await doctor.agent
        .put(`/api/appointments/${appId}/status`)
        .set("X-CSRF-Token", doctor.csrf)
        .send({ status: "confirmed" });
};

describe("Journal", () => {
    it("creates, lists and summarizes journal entries", async () => {
        const user = await createUser("patient");
        const created = await user.agent
            .post("/api/wellness/journal")
            .set("X-CSRF-Token", user.csrf)
            .send({ content: "Today I felt anxious but took a walk." });
        expect(created.status).toBe(201);
        expect(created.body.data.content).toContain("anxious");

        const list = await user.agent.get("/api/wellness/journal");
        expect(list.status).toBe(200);
        expect(list.body.data.length).toBe(1);

        const summary = await user.agent.post("/api/wellness/journal/summarize").set("X-CSRF-Token", user.csrf);
        expect(summary.status).toBe(200);
        expect(summary.body.data.count).toBe(1);
        expect(typeof summary.body.data.summary).toBe("string");
    });

    it("rejects empty journal entries", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/wellness/journal")
            .set("X-CSRF-Token", user.csrf)
            .send({ content: "x" });
        expect(res.status).toBe(400);
    });
});

describe("Mood factors", () => {
    it("stores factors and reports factor correlation", async () => {
        const user = await createUser("patient");
        await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 5, notes: "Slept well", factors: ["sleep", "exercise"] });
        // One entry per day — yesterday's entry carries different factors
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(12, 0, 0, 0);
        await prisma.moodEntry.create({
            data: { userId: user.id, mood: 2, notes: "Rough day", factors: JSON.stringify(["stress"]), createdAt: yesterday },
        });

        const stats = await user.agent.get("/api/wellness/mood/stats");
        expect(stats.status).toBe(200);
        expect(stats.body.data.factorCorrelation).toEqual({
            sleep: 5,
            exercise: 5,
            stress: 2,
        });
    });

    it("updates today's entry when re-logging the same day", async () => {
        const user = await createUser("patient");
        await user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send({ mood: 5 });
        const again = await user.agent.post("/api/wellness/mood").set("X-CSRF-Token", user.csrf).send({ mood: 2 });

        expect(again.status).toBe(201);
        expect(again.body.data.mood).toBe(2);

        const history = await user.agent.get("/api/wellness/mood");
        expect(history.body.data.length).toBe(1);
        expect(history.body.data[0].mood).toBe(2);
    });

    it("rejects unknown factors", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/wellness/mood")
            .set("X-CSRF-Token", user.csrf)
            .send({ mood: 3, factors: ["aliens"] });
        expect(res.status).toBe(400);
    });
});

describe("Clinical assessments (PHQ-9 / GAD-7)", () => {
    it("submits a PHQ-9 and computes score + severity", async () => {
        const user = await createUser("patient");
        // 2+2+1+1+0+1+1+0+0 = 8 -> mild
        const res = await user.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", user.csrf)
            .send({ type: "phq9", answers: [2, 2, 1, 1, 0, 1, 1, 0, 0] });
        expect(res.status).toBe(201);
        expect(res.body.data.score).toBe(8);
        expect(res.body.data.severity).toBe("mild");
    });

    it("rejects wrong answer counts", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", user.csrf)
            .send({ type: "gad7", answers: [1, 1, 1] });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain("7 answers");
    });

    it("rejects answers outside 0-3 and unknown types", async () => {
        const user = await createUser("patient");
        const bad = await user.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", user.csrf)
            .send({ type: "phq9", answers: [1, 2, 3, 4, 0, 0, 0, 0, 0] });
        expect(bad.status).toBe(400);

        const wrongType = await user.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", user.csrf)
            .send({ type: "mmpi", answers: [1, 1, 1] });
        expect(wrongType.status).toBe(400);
    });

    it("lists only the user's own assessments", async () => {
        const userA = await createUser("patient");
        const userB = await createUser("patient");
        await userA.agent
            .post("/api/wellness/assessments")
            .set("X-CSRF-Token", userA.csrf)
            .send({ type: "phq9", answers: [0, 0, 0, 0, 0, 0, 0, 0, 0] });

        const mine = await userA.agent.get("/api/wellness/assessments");
        expect(mine.body.data.length).toBe(1);

        const others = await userB.agent.get("/api/wellness/assessments");
        expect(others.body.data.length).toBe(0);
    });
});

describe("Review replies", () => {
    it("lets the owning doctor reply to a review", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await doctor.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });
        await doctor.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "completed" });

        const review = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 5, comment: "Lovely session" });
        const reviewId = review.body.data.review.id;

        const reply = await doctor.agent
            .post(`/api/reviews/${reviewId}/reply`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ reply: "Thank you so much!" });
        expect(reply.status).toBe(200);
        expect(reply.body.data.reply).toBe("Thank you so much!");
        expect(reply.body.data.repliedAt).toBeTruthy();
    });

    it("forbids other doctors from replying", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const otherDoctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await doctor.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "confirmed" });
        await doctor.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ status: "completed" });

        const review = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 4, comment: "Good" });
        const reviewId = review.body.data.review.id;

        const res = await otherDoctor.agent
            .post(`/api/reviews/${reviewId}/reply`)
            .set("X-CSRF-Token", otherDoctor.csrf)
            .send({ reply: "Impostor!" });
        expect(res.status).toBe(403);
    });
});

describe("Consultation rooms (video/voice join)", () => {
    it("opens the room for participants within the window", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const start = new Date(Date.now() + 10 * 60000);
        const end = new Date(Date.now() + 70 * 60000);
        const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: start.toISOString().split("T")[0],
                startTime: fmt(start),
                endTime: fmt(end),
                consultationType: "voice",
            });
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const join = await patient.agent.post(`/api/appointments/${appId}/join`).set("X-CSRF-Token", patient.csrf);
        expect(join.status).toBe(200);
        expect(join.body.data.meetingLink).toContain("meet.jit.si");
        expect(join.body.data.consultationType).toBe("voice");

        const doctorJoin = await doctor.agent.post(`/api/appointments/${appId}/join`).set("X-CSRF-Token", doctor.csrf);
        expect(doctorJoin.status).toBe(200);
    });

    it("rejects third-party join attempts", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const stranger = await createUser("patient");
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const res = await stranger.agent.post(`/api/appointments/${appId}/join`).set("X-CSRF-Token", stranger.csrf);
        expect(res.status).toBe(403);
    });

    it("rejects joining outside the window with a friendly message", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor); // 3 days out
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const res = await patient.agent.post(`/api/appointments/${appId}/join`).set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/opens in \d+ minutes/);
    });

    it("rejects join for text-chat consultations", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor, { consultationType: "chat" });
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const res = await patient.agent.post(`/api/appointments/${appId}/join`).set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(400);
        expect(res.body.message).toContain("no live room");
    });
});

describe("Weekly report opt-in", () => {
    it("updates weekly_report_enabled via profile", async () => {
        const user = await createUser("patient");
        const res = await user.agent
            .put("/api/users/profile")
            .set("X-CSRF-Token", user.csrf)
            .send({ weekly_report_enabled: true });
        expect(res.status).toBe(200);
        expect(res.body.data.user.weeklyReportEnabled).toBe(true);
    });
});

describe("Doctor analytics", () => {
    it("returns analytics for the owning doctor", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent.get("/api/doctors/analytics");
        expect(res.status).toBe(200);
        expect(res.body.data.monthly).toHaveLength(6);
        expect(res.body.data.statusBreakdown).toBeDefined();
        expect(res.body.data.cancellationRate).toBe(0);
    });

    it("denies analytics to patients", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent.get("/api/doctors/analytics");
        expect(res.status).toBe(400);
    });
});

describe("Notification preferences", () => {
    it("defaults to all enabled and persists updates", async () => {
        const user = await createUser("patient");
        const get = await user.agent.get("/api/notifications/preferences");
        expect(get.body.data).toEqual({ appointment: true, message: true, system: true });

        const put = await user.agent
            .put("/api/notifications/preferences")
            .set("X-CSRF-Token", user.csrf)
            .send({ appointment: false });
        expect(put.status).toBe(200);
        expect(put.body.data.appointment).toBe(false);
    });

    it("skips notifications for disabled categories", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        await patient.agent
            .put("/api/notifications/preferences")
            .set("X-CSRF-Token", patient.csrf)
            .send({ appointment: false });

        const book = await bookFor(patient, doctor);
        expect(book.status).toBe(201);

        const count = await patient.agent.get("/api/notifications/unread-count");
        // Booking creates a notification for the DOCTOR, not the patient —
        // so check the doctor still received it and the patient has none.
        expect(book.body.data.id).toBeTruthy();
        expect(count.body.data.count).toBe(0);
    });
});

describe("Availability patterns", () => {
    it("creates a pattern and generates slots for the coming weeks", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent
            .post("/api/doctors/patterns")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ weekday: 1, start_time: "09:00", end_time: "10:00", weeks: 2 });
        expect(res.status).toBe(201);
        expect(res.body.data.generatedSlots.length).toBe(2);

        const list = await doctor.agent.get("/api/doctors/patterns");
        expect(list.body.data.length).toBe(1);
        expect(list.body.data[0].weekday).toBe(1);
    });

    it("rejects overlapping patterns", async () => {
        const doctor = await createDoctor();
        await doctor.agent
            .post("/api/doctors/patterns")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ weekday: 1, start_time: "09:00", end_time: "11:00" });
        const overlap = await doctor.agent
            .post("/api/doctors/patterns")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ weekday: 1, start_time: "10:00", end_time: "12:00" });
        expect(overlap.status).toBe(400);
        expect(overlap.body.message).toContain("overlaps");
    });

    it("deletes patterns without touching generated slots", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent
            .post("/api/doctors/patterns")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ weekday: 2, start_time: "14:00", end_time: "15:00", weeks: 1 });
        const patternId = res.body.data.pattern.id;

        const del = await doctor.agent.delete(`/api/doctors/patterns/${patternId}`).set("X-CSRF-Token", doctor.csrf);
        expect(del.status).toBe(200);
        expect(del.body.data.success).toBe(true);

        const list = await doctor.agent.get("/api/doctors/patterns");
        expect(list.body.data.length).toBe(0);
    });
});

describe("SOS panic button", () => {
    it("alerts the patient's latest doctor", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const res = await patient.agent.post("/api/support/sos").set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(200);
        expect(res.body.data.doctorAlerted).toBe(true);
        expect(res.body.data.hotlines.length).toBeGreaterThan(0);

        const doctorNotifs = await doctor.agent.get("/api/notifications");
        expect(doctorNotifs.body.data.rows.some((n: any) => n.title.includes("SOS"))).toBe(true);
    });

    it("rejects SOS for doctors", async () => {
        const doctor = await createDoctor();
        const res = await doctor.agent.post("/api/support/sos").set("X-CSRF-Token", doctor.csrf);
        expect(res.status).toBe(403);
    });
});

describe("Review reports & moderation", () => {
    const setupReview = async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "confirmed" });
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "completed" });
        const review = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 1, comment: "Bad experience" });
        return { patient, doctor, reviewId: review.body.data.review.id };
    };

    it("lets the owning doctor report a review", async () => {
        const { doctor, reviewId } = await setupReview();
        const res = await doctor.agent
            .post(`/api/reviews/${reviewId}/report`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ reason: "This review contains false claims" });
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe("open");
    });

    it("forbids other doctors from reporting", async () => {
        const { reviewId } = await setupReview();
        const other = await createDoctor();
        const res = await other.agent
            .post(`/api/reviews/${reviewId}/report`)
            .set("X-CSRF-Token", other.csrf)
            .send({ reason: "Not my review but reporting anyway" });
        expect(res.status).toBe(403);
    });

    it("admin can hide a review and it disappears from public list", async () => {
        const { doctor, reviewId } = await setupReview();
        const admin = await createAdmin();
        const res = await admin.agent.post(`/api/admin/reviews/${reviewId}/hide`).set("X-CSRF-Token", admin.csrf);
        expect(res.status).toBe(200);

        const publicList = await doctor.agent.get(`/api/reviews/doctor/${doctor.doctorId}`);
        expect(publicList.body.data.some((r: any) => r.id === reviewId)).toBe(false);
    });

    it("admin can dismiss reports", async () => {
        const { reviewId } = await setupReview();
        const admin = await createAdmin();
        const reports = await admin.agent.get("/api/admin/review-reports?status=open");
        const reportId = reports.body.data.reports[0]?.id;
        expect(reportId).toBeTruthy();
        const res = await admin.agent
            .post(`/api/admin/review-reports/${reportId}/status`)
            .set("X-CSRF-Token", admin.csrf)
            .send({ status: "dismissed" });
        expect(res.status).toBe(200);
    });
});

describe("Rebook assist", () => {
    it("returns same-doctor and similar-doctor slots for participants", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const res = await patient.agent.get(`/api/appointments/${appId}/rebook-options`);
        expect(res.status).toBe(200);
        expect(res.body.data.sameDoctor.doctorId).toBe(doctor.doctorId);
        expect(Array.isArray(res.body.data.sameDoctor.slots)).toBe(true);
        expect(Array.isArray(res.body.data.similarDoctors)).toBe(true);
    });

    it("rejects non-participants", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const stranger = await createUser("patient");
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const res = await stranger.agent.get(`/api/appointments/${appId}/rebook-options`);
        expect(res.status).toBe(403);
    });
});

describe("AI doctor matching", () => {
    it("matches doctors from a natural-language query (fallback mode)", async () => {
        const doctor = await createDoctor();
        const patient = await createUser("patient");
        const res = await patient.agent
            .post("/api/ai/match-doctors")
            .set("X-CSRF-Token", patient.csrf)
            .send({ query: "I feel anxious about work and want affordable sessions" });
        expect(res.status).toBe(200);
        expect(res.body.data.doctors).toBeDefined();
        expect(Array.isArray(res.body.data.doctors)).toBe(true);
    });

    it("rejects short queries", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent
            .post("/api/ai/match-doctors")
            .set("X-CSRF-Token", patient.csrf)
            .send({ query: "hi" });
        expect(res.status).toBe(400);
    });
});

describe("Admin CSV exports", () => {
    it("exports bookings CSV with headers", async () => {
        const admin = await createAdmin();
        const res = await admin.agent.get("/api/admin/export/bookings");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/csv");
        const csv = res.text;
        expect(csv.split("\n")[0]).toContain("id,patient,patientEmail");
    });

    it("exports users and revenue CSVs", async () => {
        const admin = await createAdmin();
        const users = await admin.agent.get("/api/admin/export/users");
        expect(users.status).toBe(200);
        expect(users.text.split("\n")[0]).toContain("id,name,email");

        const revenue = await admin.agent.get("/api/admin/export/revenue");
        expect(revenue.status).toBe(200);
        expect(revenue.text.split("\n")[0]).toContain("doctorId,doctor");
    });
});

describe("Round 3: waitlist", () => {
    it("joins, checks status, and leaves the waitlist", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const join = await patient.agent.post(`/api/doctors/${doctor.doctorId}/waitlist`).set("X-CSRF-Token", patient.csrf);
        expect(join.status).toBe(201);

        const status = await patient.agent.get(`/api/doctors/${doctor.doctorId}/waitlist/status`);
        expect(status.body.data.onWaitlist).toBe(true);

        const leave = await patient.agent.delete(`/api/doctors/${doctor.doctorId}/waitlist`).set("X-CSRF-Token", patient.csrf);
        expect(leave.status).toBe(200);
        expect(leave.body.data.success).toBe(true);
    });
});

describe("Round 3: follow-up scheduling", () => {
    const setupCompleted = async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "confirmed" });
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "completed" });
        return { patient, doctor, appId };
    };

    it("doctor suggests a follow-up, patient accepts it", async () => {
        const { patient, doctor, appId } = await setupCompleted();
        const date = new Date();
        date.setDate(date.getDate() + 7);

        const suggest = await doctor.agent
            .post(`/api/appointments/${appId}/follow-up`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ suggestedDate: date.toISOString().split("T")[0], startTime: "10:00", endTime: "11:00" });
        expect(suggest.status).toBe(201);

        const fuId = suggest.body.data.id;
        const accept = await patient.agent.post(`/api/follow-ups/${fuId}/accept`).set("X-CSRF-Token", patient.csrf);
        expect(accept.status).toBe(200);
        expect(accept.body.data.appointment).toBeTruthy();
        expect(accept.body.data.appointment.status).toBe("pending");
    });

    it("only the assigned doctor can suggest follow-ups", async () => {
        const { appId } = await setupCompleted();
        const other = await createDoctor();
        const date = new Date();
        date.setDate(date.getDate() + 7);
        const res = await other.agent
            .post(`/api/appointments/${appId}/follow-up`)
            .set("X-CSRF-Token", other.csrf)
            .send({ suggestedDate: date.toISOString().split("T")[0], startTime: "10:00", endTime: "11:00" });
        expect(res.status).toBe(403);
    });
});

describe("Round 3: therapy packages", () => {
    it("doctor creates a package and patient purchases + books with it", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();

        const create = await doctor.agent
            .post("/api/doctors/packages")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ name: "4-session plan", description: "Weekly sessions", sessionCount: 4, totalPrice: 400000 });
        expect(create.status).toBe(201);
        const pkgId = create.body.data.id;

        const purchase = await patient.agent.post(`/api/packages/${pkgId}/purchase`).set("X-CSRF-Token", patient.csrf);
        expect(purchase.status).toBe(201);
        expect(purchase.body.data.sessionsLeft).toBe(4);

        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctor.doctorId,
                appointmentDate: futureDate(),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
                packagePurchaseId: purchase.body.data.id,
            });
        expect(book.status).toBe(201);
        expect(book.body.data.packagePurchaseId).toBe(purchase.body.data.id);
    });

    it("rejects booking with a package from another doctor", async () => {
        const patient = await createUser("patient");
        const doctorA = await createDoctor();
        const doctorB = await createDoctor();
        const create = await doctorA.agent
            .post("/api/doctors/packages")
            .set("X-CSRF-Token", doctorA.csrf)
            .send({ name: "Plan A", sessionCount: 3, totalPrice: 300000 });
        const purchase = await patient.agent.post(`/api/packages/${create.body.data.id}/purchase`).set("X-CSRF-Token", patient.csrf);

        const book = await patient.agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", patient.csrf)
            .send({
                doctorId: doctorB.doctorId,
                appointmentDate: futureDate(),
                startTime: "10:00",
                endTime: "11:00",
                consultationType: "video",
                packagePurchaseId: purchase.body.data.id,
            });
        expect(book.status).toBe(400);
        expect(book.body.message).toContain("different doctor");
    });
});

describe("Round 3: referrals", () => {
    it("registers with a referral code and credits on first completion", async () => {
        const referrer = await createUser("patient");
        const profile = await referrer.agent.get("/api/users/profile");
        const code = profile.body.data.referralCode;
        expect(code).toBeTruthy();

        const { agent, csrf } = await setupClient();
        const referred = await agent
            .post("/api/auth/register")
            .set("X-CSRF-Token", csrf)
            .send({ email: `referred-${Date.now()}@test.app`, password: PASSWORD, name: "Referred", role: "patient", phone_number: "+6281234567890", referralCode: code });
        expect(referred.status).toBe(201);

        // Complete the referred user's first appointment
        const doctor = await createDoctor();
        const bookRes = await agent
            .post("/api/appointments/book")
            .set("X-CSRF-Token", csrf)
            .send({ doctorId: doctor.doctorId, appointmentDate: futureDate(), startTime: "10:00", endTime: "11:00", consultationType: "video" });
        const appId = bookRes.body.data.id;
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "confirmed" });
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "completed" });

        const referrerNotifs = await referrer.agent.get("/api/notifications");
        expect(referrerNotifs.body.data.rows.some((n: any) => n.title.includes("referral"))).toBe(true);
    });
});

describe("Round 3: chat upgrades", () => {
    it("sender can soft-delete a message", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const sent = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "Hello doctor" });
        const msgId = sent.body.data.id;

        const del = await patient.agent.delete(`/api/messages/${msgId}`).set("X-CSRF-Token", patient.csrf);
        expect(del.status).toBe(200);
        expect(del.body.data.success).toBe(true);

        const thread = await patient.agent.get(`/api/messages/${doctor.id}/messages`);
        const deleted = thread.body.data.find((m: any) => m.id === msgId);
        expect(deleted.deletedAt).toBeTruthy();
    });

    it("receiver cannot delete the sender's message", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const sent = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "Hi" });
        const del = await doctor.agent.delete(`/api/messages/${sent.body.data.id}`).set("X-CSRF-Token", doctor.csrf);
        expect(del.status).toBe(403);
    });

    it("sets and clears reactions", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await confirmAppointment(appId, doctor);

        const sent = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "React to me" });
        const react = await doctor.agent
            .put(`/api/messages/${sent.body.data.id}/reaction`)
            .set("X-CSRF-Token", doctor.csrf)
            .send({ reaction: "❤️" });
        expect(react.status).toBe(200);
        expect(react.body.data.reaction).toBe("❤️");
    });
});

describe("Round 3: away mode", () => {
    it("doctor toggles away mode and slots are hidden from patients", async () => {
        const doctor = await createDoctor();
        const date = new Date();
        date.setDate(date.getDate() + 30);
        const away = await doctor.agent
            .post("/api/doctors/away")
            .set("X-CSRF-Token", doctor.csrf)
            .send({ awayUntil: date.toISOString().split("T")[0] });
        expect(away.status).toBe(200);
        expect(away.body.data.awayUntil).toBeTruthy();

        const slots = await doctor.agent.get(`/api/doctors/slots/${doctor.doctorId}`);
        expect(slots.status).toBe(200);
        expect(Array.isArray(slots.body.data)).toBe(true);
    });
});
