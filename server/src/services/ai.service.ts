import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

export class AIService {
    private static getModel() {
        if (!genAI) throw new Error("GEMINI_API_KEY is not configured");
        return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    }

    private static async generate(prompt: string): Promise<string | null> {
        try {
            const model = this.getModel();
            const result = await model.generateContent(prompt);
            return result.response.text().trim();
        } catch (error: any) {
            console.error("[AI Service] Gemini call failed, using fallback:", error.message);
            return null;
        }
    }

    /**
     * Conversational assistant call with a system prompt and message history.
     * Returns null when Gemini is unavailable so callers can fall back.
     */
    static async chat(
        systemPrompt: string,
        history: { role: "user" | "assistant"; content: string }[]
    ): Promise<string | null> {
        try {
            const model = this.getModel();
            const conversation = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
            const prompt = `${systemPrompt}\n\nConversation so far:\n${conversation.join("\n")}\n\nAssistant:`;
            const result = await model.generateContent(prompt);
            const text = result.response.text().trim();
            return text || null;
        } catch (error: any) {
            console.error("[AI Service] chat call failed, using fallback:", error.message);
            return null;
        }
    }

    static async generatePreSessionQuestions(
        specialty: string,
        appointmentNotes?: string
    ): Promise<string[]> {
        const prompt = `You are a compassionate mental health assistant for MindEase, a mental health platform.
A patient has an upcoming session with a ${specialty} specialist.
${appointmentNotes ? `Patient's notes: "${appointmentNotes}"` : "No prior notes provided."}

Generate exactly 5 thoughtful, gentle pre-session questions to help the patient reflect before their appointment.
The questions should:
- Be warm and non-judgmental
- Help the patient articulate their feelings
- Cover recent mood, sleep, triggers, goals for the session, and coping strategies
- Be appropriate for a mental health context

Return ONLY a JSON array of 5 strings, no markdown formatting, no explanation. Example:
["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?"]`;

        const fallback = [
            "How have you been feeling emotionally this past week?",
            "Have you noticed any changes in your sleep or appetite?",
            "What situations or thoughts have been most challenging lately?",
            "What would you most like to address in this session?",
            "Are there any coping strategies that have been helpful or unhelpful?",
        ];

        const text = await this.generate(prompt);
        if (!text) return fallback;

        try {
            const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
            const parsed = JSON.parse(cleaned);
            return Array.isArray(parsed) && parsed.length > 0 && parsed.every((q) => typeof q === "string")
                ? parsed.slice(0, 5)
                : fallback;
        } catch {
            return fallback;
        }
    }

    static async summarizeJournal(
        entries: string[],
        from: Date,
        to: Date
    ): Promise<string | null> {
        const range = `${from.toLocaleDateString("en-GB")} – ${to.toLocaleDateString("en-GB")}`;
        const journalText = entries
            .map((e, i) => `Entry ${i + 1}: ${e}`)
            .join("\n\n");

        const prompt = `You are a supportive wellness coach for MindEase, a mental health platform.
A user has shared ${entries.length} journal entries between ${range}.

Journal entries:
${journalText}

Write a warm, concise summary (2-3 sentences) that:
- Reflects the emotional themes across their entries
- Gently names any recurring patterns (sleep, stress, relationships, work)
- Ends with one compassionate, actionable suggestion

Return ONLY the summary text, no markdown, no formatting.`;

        const result = await this.generate(prompt);
        if (!result) {
            return (
                `You wrote ${entries.length} journal entries this week — an excellent habit. ` +
                "Re-reading them later can reveal patterns in what lifts you up and what drains you. " +
                "Keep going, one entry at a time."
            );
        }
        return result;
    }

    static async generateDoctorBriefing(
        patientName: string,
        specialty: string,
        moodHistory: { mood: number; notes: string | null; createdAt: Date }[],
        preSessionAnswers: { question: string; answer: string }[],
        assessments?: { type: string; score: number; severity: string }[]
    ): Promise<string> {
        const moodSummary = moodHistory.length > 0
            ? moodHistory.map((m) => `Mood: ${m.mood}/5${m.notes ? ` — "${m.notes}"` : ""}`).join("; ")
            : "No mood data available.";

        const answersText = preSessionAnswers.length > 0
            ? preSessionAnswers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")
            : "Patient did not complete pre-session questions.";

        const assessmentText =
            assessments && assessments.length > 0
                ? assessments
                      .map((a) => `${a.type.toUpperCase()} screening: score ${a.score}/21 or /27 — ${a.severity}`)
                      .join("; ")
                : "No screening assessments on record.";

        const prompt = `You are a clinical assistant for MindEase. Generate a concise, professional briefing paragraph for a ${specialty} doctor about their upcoming patient.

Patient: ${patientName}
Recent Mood History: ${moodSummary}
Screening Assessments: ${assessmentText}

Pre-Session Responses:
${answersText}

Write a single professional paragraph (3-5 sentences) that:
- Summarizes the patient's emotional state and trends
- References any screening scores (PHQ-9/GAD-7) with appropriate clinical caution
- Highlights key concerns the patient raised
- Suggests areas to explore during the session
- Uses clinical but warm language

Return ONLY the paragraph text, no markdown, no formatting.`;

        const result = await this.generate(prompt);
        if (!result) {
            // Local fallback: compile a data-driven summary without the LLM
            const avg = moodHistory.length
                ? (moodHistory.reduce((s, m) => s + m.mood, 0) / moodHistory.length).toFixed(1)
                : "n/a";
            const concerns = preSessionAnswers
                .map((a) => a.answer)
                .join(" ")
                .trim();
            const screening = assessments && assessments.length > 0
                ? ` Latest screening: ${assessments.map((a) => `${a.type.toUpperCase()} ${a.score} (${a.severity})`).join(", ")}.`
                : "";
            return (
                `Patient has logged ${moodHistory.length} mood entries in the past 14 days with an average of ${avg}/5.` +
                screening +
                (concerns ? ` They shared: "${concerns.slice(0, 200)}". ` : " ") +
                "Consider exploring sleep quality, stress triggers, and coping strategies. " +
                "Revisit their pre-session responses during the session for deeper context."
            );
        }

        return result;
    }

    static async suggestResources(
        recentMoods: { mood: number; notes: string | null }[]
    ): Promise<{ title: string; description: string; type: string }[]> {
        const moodData = recentMoods.length > 0
            ? recentMoods.map((m) => `${m.mood}/5${m.notes ? ` ("${m.notes}")` : ""}`).join(", ")
            : "No mood data yet";

        const avgMood = recentMoods.length > 0
            ? (recentMoods.reduce((sum, m) => sum + m.mood, 0) / recentMoods.length).toFixed(1)
            : "unknown";

        const prompt = `You are a wellness advisor for MindEase, a mental health app.
Based on the patient's recent mood data, suggest 3 personalized wellness activities.

Recent moods: ${moodData}
Average mood: ${avgMood}/5

Return ONLY a JSON array of 3 objects, each with:
- "title": short activity name
- "description": 1-2 sentence explanation
- "type": one of "exercise", "meditation", "journaling", "breathing", "social", "creative"

No markdown formatting. Example:
[{"title":"5-Minute Breathing","description":"Try box breathing to reduce anxiety.","type":"breathing"}]`;

        const fallback = [
            { title: "Deep Breathing", description: "Try 4-7-8 breathing for 5 minutes to calm your mind.", type: "breathing" },
            { title: "Gratitude Journal", description: "Write down 3 things you're grateful for today.", type: "journaling" },
            { title: "Gentle Walk", description: "Take a 15-minute walk outside to boost your mood.", type: "exercise" },
        ];

        const text = await this.generate(prompt);
        if (!text) return fallback;

        try {
            const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
            const parsed = JSON.parse(cleaned);
            if (
                Array.isArray(parsed) &&
                parsed.length > 0 &&
                parsed.every(
                    (s) =>
                        s &&
                        typeof s.title === "string" &&
                        typeof s.description === "string" &&
                        typeof s.type === "string"
                )
            ) {
                return parsed.slice(0, 3);
            }
            return fallback;
        } catch {
            return fallback;
        }
    }

    /**
     * Natural-language doctor matching: parses the patient's query into
     * structured filters. Returns null when Gemini is unavailable so the
     * controller can fall back to keyword matching.
     */
    static async matchDoctors(
        query: string
    ): Promise<{ specialty?: string; maxPrice?: number; minExperience?: number; keywords: string[] } | null> {
        const prompt = `You are a matching assistant for MindEase, a mental health platform in Indonesia.
A patient described what they need in their own words. Extract structured search criteria.

Patient's request: "${query}"

Return ONLY a JSON object with:
- "specialty": the most likely psychologist specialty (e.g. "Clinical Psychologist", "Family", "Trauma", "Addiction", "General Psychologist") or null if unknown
- "maxPrice": maximum session price in IDR as a number, or null
- "minExperience": minimum experience in years as a number, or null
- "keywords": 3-6 short English keywords capturing what the patient is looking for

No markdown formatting. Example:
{"specialty":"Clinical Psychologist","maxPrice":300000,"minExperience":null,"keywords":["anxiety","stress relief","panic"]}`;

        const fallback: { specialty?: string; maxPrice?: number; minExperience?: number; keywords: string[] } = {
            keywords: query.split(/\s+/).filter((w) => w.length > 3).slice(0, 6),
        };

        const text = await this.generate(prompt);
        if (!text) return fallback;

        try {
            const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
            const parsed = JSON.parse(cleaned);
            return {
                specialty: typeof parsed.specialty === "string" ? parsed.specialty : undefined,
                maxPrice: typeof parsed.maxPrice === "number" ? parsed.maxPrice : undefined,
                minExperience: typeof parsed.minExperience === "number" ? parsed.minExperience : undefined,
                keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 6) : [],
            };
        } catch {
            return fallback;
        }
    }
}
