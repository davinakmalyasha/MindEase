import { prisma } from "../lib/prisma";
import { AIService } from "./ai.service";
import { WellnessService } from "./wellness.service";



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
            throw new Error("Appointment not found");
        }
        if (appointment.status !== status && !(status === "confirmed" && appointment.status === "completed")) {
            throw new Error(`Questions are only available for ${status} appointments`);
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
            update: { questionsJson: JSON.stringify(questions) },
            create: { appointmentId, questionsJson: JSON.stringify(questions) },
        });

        return { questions, alreadyGenerated: false };
    }

    static async getData(appointmentId: number, user: { id: number; role: string }) {
        const appointment = await this.getAppointment(appointmentId);
        if (!appointment) throw new Error("Appointment not found");

        const isPatient = appointment.userId === user.id;
        const isDoctor =
            user.role === "doctor" && appointment.doctor.userId === user.id;
        if (!isPatient && !isDoctor && user.role !== "admin") {
            throw new Error("Forbidden: not your appointment");
        }

        const data = await prisma.preSessionData.findUnique({ where: { appointmentId } });
        if (!data) return null;

        return {
            questions: parseJson<string[]>(data.questionsJson, []),
            answers: parseJson<{ question: string; answer: string }[]>(data.answersJson, []),
            briefingText: data.briefingText,
        };
    }

    static async submitAnswers(appointmentId: number, userId: number, answers: { question: string; answer: string }[]) {
        this.assertPatient(await this.getAppointment(appointmentId), userId, "confirmed");

        const data = await prisma.preSessionData.findUnique({ where: { appointmentId } });
        if (!data?.questionsJson) {
            throw new Error("Pre-session questions have not been generated yet");
        }

        await prisma.preSessionData.upsert({
            where: { appointmentId },
            update: { answersJson: JSON.stringify(answers) },
            create: { appointmentId, answersJson: JSON.stringify(answers) },
        });

        // Invalidate any previously generated briefing
        await prisma.preSessionData.update({
            where: { appointmentId },
            data: { briefingText: null },
        });

        return { success: true };
    }

    static async getBriefing(appointmentId: number, userId: number) {
        const appointment = await this.getAppointment(appointmentId);
        if (!appointment) throw new Error("Appointment not found");
        if (appointment.doctor.userId !== userId) {
            throw new Error("Forbidden: briefing is restricted to the assigned doctor");
        }

        const data = await prisma.preSessionData.findUnique({ where: { appointmentId } });
        if (data?.briefingText) {
            const moodHistory = await WellnessService.getMoodHistory(appointment.userId, 14);
            const assessments = await WellnessService.getLatestAssessments(appointment.userId);
            return {
                briefing: data.briefingText,
                cached: true,
                moodHistory: moodHistory.map((m) => ({ mood: m.mood, createdAt: m.createdAt, notes: m.notes })),
                answers: parseJson<{ question: string; answer: string }[]>(data.answersJson ?? null, []),
                assessments,
            };
        }

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

        await prisma.preSessionData.upsert({
            where: { appointmentId },
            update: { briefingText: briefing },
            create: { appointmentId, briefingText: briefing },
        });

        return {
            briefing,
            cached: false,
            moodHistory: moodHistory.map((m) => ({ mood: m.mood, createdAt: m.createdAt, notes: m.notes })),
            answers,
            assessments,
        };
    }
}
