import { prisma } from "../lib/prisma";
import { AIService, type AiSource } from "./ai.service";
import { WellnessService } from "./wellness.service";
import { badRequest, forbidden, notFound } from "../utils/appError";
import { AuditService } from "./audit.service";



const parseJson = <T>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
};

export class PreSessionService {
    private static async getAppointment(appointmentId: number) {
        return await prisma.appointment.findUnique({
            where: { id: appointmentId },
            include: {
                doctor: { select: { specialty: true, userId: true } },
                user: { select: { name: true } },
            },
        });
    }

    private static assertPatient(appointment: any, userId: number, status = "confirmed") {
        if (!appointment || appointment.userId !== userId) {
            throw notFound("Appointment not found");
        }
        if (appointment.status !== status && !(status === "confirmed" && appointment.status === "completed")) {
            throw badRequest(`Questions are only available for ${status} appointments`);
        }
        return appointment;
    }

    static async getQuestionsForPatient(appointmentId: number, userId: number) {
        const appointment = this.assertPatient(await this.getAppointment(appointmentId), userId, "confirmed");

        const existing = await prisma.preSessionData.findUnique({
            where: { appointmentId },
        });
        if (existing?.questionsJson) {
            return { questions: parseJson<string[]>(existing.questionsJson, []), alreadyGenerated: true };
        }

        const questions = await AIService.generatePreSessionQuestions(
            appointment.doctor.specialty,
            appointment.notes || undefined
        );

        await prisma.preSessionData.upsert({
            where: { appointmentId },
            update: { questionsJson: JSON.stringify(questions.data) },
            create: { appointmentId, questionsJson: JSON.stringify(questions.data) },
        });

        return {
            questions: questions.data,
            alreadyGenerated: false,
            // The patient is answering these before they see them, so whether
            // they are personalised or a fixed set is worth stating.
            ai: { source: questions.source, degradedReason: questions.degradedReason },
        };
    }

    /**
     * The patient's own pre-session form, or the assigned doctor's view of it.
     *
     * Two things this used to get wrong:
     *
     *   1. It admitted `role === "admin"`. Pre-session answers are the patient
     *      describing their own mental health in their own words, and the brief
     *      derived from them; the requirement is that they reach the assigned
     *      clinician and nobody else. An administrator account is not a
     *      clinician, and a support agent with the admin role should not be able
     *      to read a patient's disclosures.
     *   2. It never checked appointment status, while the two methods that can
     *      reach Gemini both did. A doctor could therefore read a patient's
     *      pre-session answers for a `pending` or `cancelled` appointment.
     */
    static async getData(appointmentId: number, user: { id: number; role: string }) {
        const appointment = await this.getAppointment(appointmentId);
        if (!appointment) throw notFound("Appointment not found");

        const isPatient = appointment.userId === user.id;
        const isAssignedDoctor = user.role === "doctor" && appointment.doctor.userId === user.id;

        if (isPatient) {
            // The patient may read their own answers only once the session is
            // live; before confirmation there is nothing for them to complete.
            if (appointment.status === "cancelled") {
                throw forbidden("this appointment was cancelled");
            }
        } else if (isAssignedDoctor) {
            if (appointment.status === "pending") {
                throw forbidden("pre-session data is available once the patient confirms");
            }
        } else {
            throw forbidden("not your appointment");
        }

        const data = await prisma.preSessionData.findUnique({ where: { appointmentId } });
        if (!data) return null;

        return {
            questions: parseJson<string[]>(data.questionsJson, []),
            answers: parseJson<{ question: string; answer: string }[]>(data.answersJson, []),
            briefingText: isAssignedDoctor ? data.briefingText : null,
        };
    }

    static async submitAnswers(appointmentId: number, userId: number, answers: { question: string; answer: string }[]) {
        this.assertPatient(await this.getAppointment(appointmentId), userId, "confirmed");

        const data = await prisma.preSessionData.findUnique({ where: { appointmentId } });
        if (!data?.questionsJson) {
            throw badRequest("Pre-session questions have not been generated yet");
        }

        await prisma.preSessionData.upsert({
            where: { appointmentId },
            update: { answersJson: JSON.stringify(answers) },
            create: { appointmentId, answersJson: JSON.stringify(answers) },
        });

        // Invalidate any previously generated briefing.
        //
        // `briefingSource` is deliberately left alone: it is only meaningful
        // alongside a non-null `briefingText`, and the regeneration that follows
        // rewrites both together in one upsert. Clearing it to the column
        // default here would instead assert "model" about a briefing that does
        // not exist.
        await prisma.preSessionData.update({
            where: { appointmentId },
            data: { briefingText: null },
        });

        return { success: true };
    }

    static async getBriefing(appointmentId: number, userId: number) {
        const appointment = await this.getAppointment(appointmentId);
        if (!appointment) throw notFound("Appointment not found");
        if (appointment.doctor.userId !== userId) {
            throw forbidden("briefing is restricted to the assigned doctor");
        }
        // The status gate the other methods have. Without it a doctor could
        // generate — and be billed for — a briefing from a patient's mood
        // history and PHQ-9 scores for an appointment that is still pending or
        // has been cancelled.
        if (appointment.status === "pending" || appointment.status === "cancelled") {
            throw forbidden("no briefing is available for this appointment");
        }

const data = await prisma.preSessionData.findUnique({ where: { appointmentId } });

        // Both paths build a payload and then fall through to one audit and one
        // return. The audit used to sit on the generation path only, which meant
        // the *cached* briefing - the one a clinician actually re-reads before
        // every session - was never recorded at all.
        let result: Record<string, unknown>;

        if (data?.briefingText) {
            const moodHistory = await WellnessService.getMoodHistory(appointment.userId, 14);
            const assessments = await WellnessService.getLatestAssessments(appointment.userId);
            result = {
                briefing: data.briefingText,
                cached: true,
                // Read back from storage rather than re-derived, so a briefing
                // generated last week still reports that it was a platform summary
                // rather than a model synthesis.
                ai: { source: data.briefingSource as AiSource },
                moodHistory: moodHistory.map((m) => ({ mood: m.mood, createdAt: m.createdAt, notes: m.notes })),
                answers: parseJson<{ question: string; answer: string }[]>(data.answersJson ?? null, []),
                assessments,
            };
        } else {
            const answers = parseJson<{ question: string; answer: string }[]>(data?.answersJson ?? null, []);
            const moodHistory = await WellnessService.getMoodHistory(appointment.userId, 14);
            const assessments = await WellnessService.getLatestAssessments(appointment.userId);

            const briefing = await AIService.generateDoctorBriefing(
                appointment.user?.name || "Patient",
                appointment.doctor.specialty,
                moodHistory,
                answers,
                assessments
            );

            // The origin is persisted with the text, not just returned, because this
            // row is re-read later and a flag that lived only on this response would
            // be gone by the time a clinician opened the cached briefing.
            await prisma.preSessionData.upsert({
                where: { appointmentId },
                update: { briefingText: briefing.data, briefingSource: briefing.source },
                create: { appointmentId, briefingText: briefing.data, briefingSource: briefing.source },
            });

            result = {
                briefing: briefing.data,
                cached: false,
                ai: { source: briefing.source, degradedReason: briefing.degradedReason },
                moodHistory: moodHistory.map((m) => ({ mood: m.mood, createdAt: m.createdAt, notes: m.notes })),
                answers,
                assessments,
            };
        }

        // A briefing is the single richest clinical read in the application: the
        // patient's mood history with free-text notes, their screening scores and
        // severity, and their answers to the pre-session questions - one payload,
        // one clinician, one person. Nothing recorded that it had been opened.
        //
        // Logged after the ownership and status gates, so it records reads that
        // actually happened. A refused attempt is a different fact.
        await AuditService.logRead({
            actorId: userId,
            subjectType: "Briefing",
            subjectId: appointment.userId,
            targetId: appointmentId,
            via: result.cached ? "GET /api/ai/briefing/:appointmentId" : "POST /api/ai/briefing",
            meta: { cached: result.cached === true },
        });

        return result;
    }
}
