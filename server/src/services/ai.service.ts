import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export class AIService {
    private static getModel() {
        return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    }

    static async generatePreSessionQuestions(
        specialty: string,
        appointmentNotes?: string
    ): Promise<string[]> {
        const model = this.getModel();

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

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();

        try {
            const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
            return JSON.parse(cleaned);
        } catch {
            return [
                "How have you been feeling emotionally this past week?",
                "Have you noticed any changes in your sleep or appetite?",
                "What situations or thoughts have been most challenging lately?",
                "What would you most like to address in this session?",
                "Are there any coping strategies that have been helpful or unhelpful?",
            ];
        }
    }

    static async generateDoctorBriefing(
        patientName: string,
        specialty: string,
        moodHistory: { mood: number; notes: string | null; createdAt: Date }[],
        preSessionAnswers: { question: string; answer: string }[]
    ): Promise<string> {
        const model = this.getModel();

        const moodSummary = moodHistory.length > 0
            ? moodHistory.map((m) => `Mood: ${m.mood}/5${m.notes ? ` — "${m.notes}"` : ""}`).join("; ")
            : "No mood data available.";

        const answersText = preSessionAnswers.length > 0
            ? preSessionAnswers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")
            : "Patient did not complete pre-session questions.";

        const prompt = `You are a clinical assistant for MindEase. Generate a concise, professional briefing paragraph for a ${specialty} doctor about their upcoming patient.

Patient: ${patientName}
Recent Mood History: ${moodSummary}

Pre-Session Responses:
${answersText}

Write a single professional paragraph (3-5 sentences) that:
- Summarizes the patient's emotional state and trends
- Highlights key concerns the patient raised
- Suggests areas to explore during the session
- Uses clinical but warm language

Return ONLY the paragraph text, no markdown, no formatting.`;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    }

    static async suggestResources(
        recentMoods: { mood: number; notes: string | null }[]
    ): Promise<{ title: string; description: string; type: string }[]> {
        const model = this.getModel();

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

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();

        try {
            const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
            return JSON.parse(cleaned);
        } catch {
            return [
                { title: "Deep Breathing", description: "Try 4-7-8 breathing for 5 minutes to calm your mind.", type: "breathing" },
                { title: "Gratitude Journal", description: "Write down 3 things you're grateful for today.", type: "journaling" },
                { title: "Gentle Walk", description: "Take a 15-minute walk outside to boost your mood.", type: "exercise" },
            ];
        }
    }
}
