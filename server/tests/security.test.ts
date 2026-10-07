import { describe, it, expect } from "vitest";
import { createUser, createDoctor, createAdmin } from "./helpers";

const futureDate = (days = 3) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
};

const bookFor = async (patient: any, doctor: any) => {
    return patient.agent
        .post("/api/appointments/book")
        .set("X-CSRF-Token", patient.csrf)
        .send({ doctorId: doctor.doctorId, appointmentDate: futureDate(), startTime: "10:00", endTime: "11:00", consultationType: "video" });
};

const completeAppointment = async (appId: number, doctor: any) => {
    await doctor.agent
        .put(`/api/appointments/${appId}/status`)
        .set("X-CSRF-Token", doctor.csrf)
        .send({ status: "confirmed" });
    await doctor.agent
        .put(`/api/appointments/${appId}/status`)
        .set("X-CSRF-Token", doctor.csrf)
        .send({ status: "completed" });
};

describe("Authorization matrix (IDOR protection)", () => {
    it("patients cannot confirm appointments", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;

        const res = await patient.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ status: "confirmed" });
        // 400, not 403: this patient *does* own the appointment. The failure is
        // that only a doctor may confirm — a rule they break by asking, not an
        // authorization boundary they are refused at. The 403 came from the
        // controller hard-coding one status for the whole endpoint.
        expect(res.status).toBe(400);
    });

    it("doctors cannot confirm other doctors' appointments", async () => {
        const patient = await createUser("patient");
        const doctorA = await createDoctor();
        const doctorB = await createDoctor();
        const book = await bookFor(patient, doctorA);
        const appId = book.body.data.id;

        const res = await doctorB.agent
            .put(`/api/appointments/${appId}/status`)
            .set("X-CSRF-Token", doctorB.csrf)
            .send({ status: "confirmed" });
        expect(res.status).toBe(403);
    });

    it("only the assigned doctor can view the briefing", async () => {
        const patient = await createUser("patient");
        const doctorA = await createDoctor();
        const doctorB = await createDoctor();
        const book = await bookFor(patient, doctorA);
        const appId = book.body.data.id;
        await doctorA.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctorA.csrf).send({ status: "confirmed" });

        const denied = await doctorB.agent.get(`/api/ai/briefing/${appId}`);
        expect(denied.status).toBe(403);

        const allowed = await doctorA.agent.get(`/api/ai/briefing/${appId}`);
        expect(allowed.status).toBe(200);
    });

    it("patients cannot generate questions for other patients' appointments", async () => {
        const patient = await createUser("patient");
        const other = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await doctor.agent.put(`/api/appointments/${appId}/status`).set("X-CSRF-Token", doctor.csrf).send({ status: "confirmed" });

        const res = await other.agent
            .post("/api/ai/pre-session")
            .set("X-CSRF-Token", other.csrf)
            .send({ appointmentId: appId });
        expect(res.status).toBe(404);
        expect(res.body.message).toContain("Appointment not found");
    });

    it("patients cannot chat without a confirmed appointment", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const res = await patient.agent
            .post(`/api/messages/${doctor.id}`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ content: "hello" });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain("confirmed or completed");
    });

    it("patients cannot change another user's role (admin only)", async () => {
        const patient = await createUser("patient");
        const victim = await createUser("patient");
        const res = await patient.agent
            .patch(`/api/admin/users/${victim.id}/role`)
            .set("X-CSRF-Token", patient.csrf)
            .send({ role: "admin" });
        expect(res.status).toBe(403);
    });

    it("admin can change roles and the audit log records it", async () => {
        const admin = await createAdmin();
        const victim = await createUser("patient");

        const res = await admin.agent
            .patch(`/api/admin/users/${victim.id}/role`)
            .set("X-CSRF-Token", admin.csrf)
            .send({ role: "doctor" });
        expect(res.status).toBe(200);
        expect(res.body.data.role).toBe("doctor");

        const logs = await admin.agent.get("/api/admin/audit-logs");
        expect(logs.status).toBe(200);
        const entry = logs.body.data.logs.find((l: any) => l.targetId === victim.id);
        expect(entry?.action).toBe("user.role_changed");
        expect(entry?.meta).toContain("doctor");
    });

    it("sanitizes HTML in reviews and messages", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await completeAppointment(appId, doctor);

        const review = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 5, comment: "Great <script>alert(1)</script> doctor" });
        expect(review.status).toBe(201);
        expect(review.body.data.review.comment).not.toContain("<script>");
    });

    it("prevents duplicate reviews per appointment", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        await completeAppointment(appId, doctor);

        const first = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 5, comment: "Great!" });
        expect(first.status).toBe(201);

        const second = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 3, comment: "Dupe" });
        // 409 Conflict: the review already exists for this appointment.
        expect(second.status).toBe(409);
        expect(second.body.message).toContain("already reviewed");
    });

    it("reviews require a completed appointment", async () => {
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        const book = await bookFor(patient, doctor);
        const appId = book.body.data.id;
        // still pending — not eligible

        const res = await patient.agent
            .post("/api/reviews")
            .set("X-CSRF-Token", patient.csrf)
            .send({ doctorId: doctor.doctorId, appointmentId: appId, rating: 5, comment: "Too early" });
        expect(res.status).toBe(400);
    });
});
