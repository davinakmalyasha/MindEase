import { AIService } from "./ai.service";
import { sanitize } from "../utils/sanitize";

export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

export interface SupportReply {
    reply: string;
    crisis: boolean;
    escalated: boolean;
}

const CRISIS_PATTERNS =
    /(suicide|suicidal|kill\s*myself|end\s*my\s*life|want\s*to\s*die|don'?t\s*want\s*to\s*live|self[- ]harm|hurt\s*myself|harm\s*myself|overdose|bunuh\s*diri|mengakhiri\s*hidup|menyakiti\s*diri|ingin\s*mati|akhiri\s*hidup)/i;

const ESCALATION_PATTERNS =
    /(human|agent|customer\s*service|real\s*person|talk\s*to\s*someone|support\s*team|contact\s*support|orang\s*asli|petugas|manusia|tim\s*dukung|hubungi\s*cs)/i;

const CRISIS_REPLY =
    "You matter, and I want to make sure you're safe right now. If you're in immediate danger, please call emergency services now — in Indonesia dial 112 or 119. Free, confidential help is available 24/7:\n\n" +
    "• Kemenkes SEJIWA crisis line: **119 ext 8**\n" +
    "• Halo Kemenkes: **1500-567**\n" +
    "• Into The Light Indonesia (WhatsApp): **+62 812-123-2012**\n\n" +
    "Please don't face this alone — reach out to a hotline or someone you trust, and book a session with a licensed psychologist when you're ready. You can see all hotlines here: https://mindease.app/crisis";

const ESCALATION_REPLY =
    "Of course — our support team is happy to help you personally. Reach customer service here:\n\n" +
    "• Email: **support@mindease.id** (replies within 1 business day)\n" +
    "• WhatsApp: **+62 812 3456 7890**\n" +
    "• Contact page: https://mindease.app/contact\n\n" +
    "Is there anything I can help with in the meantime?";

const SYSTEM_PROMPT = `You are "Ease", the MindEase support assistant — a friendly, concise customer-support chatbot for MindEase, a mental health consultation platform connecting patients with licensed psychologists in Indonesia.

Know these facts about MindEase:
- Patients browse psychologists, filter by specialty/price/experience, and book hourly slots (video, voice, or chat consultations).
- Booking flow: pick a doctor → choose date and time slot → fill details → confirm. Doctors approve or reschedule requests; patients can cancel pending appointments.
- After confirmation, patients complete AI-generated pre-session reflections so the doctor can prepare a clinical briefing.
- Mood tracking: daily 1–5 mood logs, 30-day average, streaks, trend, AI wellness suggestions.
- Prices are set by each doctor and shown on their profile. There are no hidden fees.
- Registration is free for patients. Doctors register with their professional details and profiles are reviewed before going live.
- Appointments, mood data, reflections, and chats are private; data is encrypted and never sold (see privacy page).
- Customers can cancel or reschedule sessions from "My Appointments".
- Crisis help is NOT provided here: if a user shows signs of crisis, immediately share the crisis hotlines (112/119 in Indonesia, SEJIWA 119 ext 8, Halo Kemenkes 1500-567) and urge them to call.
- If a user asks for a human, point them to support@mindease.id and https://mindease.app/contact.

Rules:
- Keep answers short (2-4 sentences where possible), warm, and helpful.
- Answer in the same language the user writes in (English or Indonesian).
- Never give medical advice, diagnosis, or treatment guidance — refer them to their licensed psychologist.
- For booking/account problems you can't resolve, suggest contacting support@mindease.id.
- Never invent features or prices. If unsure, say you'll check with the team.`;

const FALLBACK_ANSWERS: { keywords: RegExp; answer: string }[] = [
    {
        keywords: /(book|booking|jadwal|reserv|session|konsultasi|buat.*janji|janji temu)/i,
        answer:
            "To book a session: open the doctor directory, choose a psychologist, pick an available date and time slot, fill in a short form about your situation, and confirm. The doctor will approve or reschedule your request. You can start at /appointments.",
    },
    {
        keywords: /(price|cost|harga|fee|biaya|bayar|tarif)/i,
        answer:
            "Each psychologist sets their own consultation price, shown on their profile — there are no hidden platform fees. You'll see the price before confirming your booking.",
    },
    {
        keywords: /(refund|cancel|cancell|batal|reschedule|ubah jadwal|jadwal ulang)/i,
        answer:
            "You can cancel or reschedule pending and confirmed appointments from \"My Appointments\" in your dashboard. Rescheduled sessions return to pending for your doctor to re-confirm.",
    },
    {
        keywords: /(mood|suasana hati|wellness|tracker|log)/i,
        answer:
            "The mood tracker lets you log how you feel on a 1–5 scale daily. MindEase computes your 30-day average, logging streak, and emotional trend, and can suggest personalized wellness activities.",
    },
    {
        keywords: /(reflection|pre-session|persiapan|briefing)/i,
        answer:
            "Once your booking is confirmed, AI generates a few compassionate questions to help you reflect before the session. Your answers are private and only shared with your assigned psychologist to help them prepare.",
    },
    {
        keywords: /(privacy|private|data|pribadi|confidential|aman)/i,
        answer:
            "Your data is protected: encrypted in transit and at rest, with strict access control. Health-related data is only visible to you and your assigned psychologist. We never sell personal data — full details on the privacy page: /privacy.",
    },
    {
        keywords: /(verify|verified|license|izin|str|sip|tersertifikasi)/i,
        answer:
            "Every psychologist on MindEase is reviewed before appearing in the directory. Approved profiles show a verified badge, and each doctor's specialty and experience are displayed on their profile page.",
    },
    {
        keywords: /(doctor|psychologist|psikolog|spesialis|join|menjadi dokter)/i,
        answer:
            "Patients can find licensed psychologists by specialty, price, and experience in the directory. Psychologists can register from the sign-up page — profiles are reviewed by our team before going live.",
    },
];

export class SupportService {
    static async chat(message: string, history: ChatMessage[] = []): Promise<SupportReply> {
        const clean = sanitize(message);

        if (CRISIS_PATTERNS.test(clean)) {
            return { reply: CRISIS_REPLY, crisis: true, escalated: false };
        }
        if (ESCALATION_PATTERNS.test(clean)) {
            return { reply: ESCALATION_REPLY, crisis: false, escalated: true };
        }

        const recent = history.slice(-10);
        const aiReply = await AIService.chat(SYSTEM_PROMPT, [...recent, { role: "user", content: clean }]);
        if (aiReply) {
            return { reply: aiReply, crisis: false, escalated: false };
        }

        const match = FALLBACK_ANSWERS.find((f) => f.keywords.test(clean));
        return {
            reply:
                match?.answer ||
                "Thanks for reaching out! I can help with booking sessions, pricing, mood tracking, privacy, and more. If you'd rather talk to a person, email support@mindease.id and our team will get back to you within one business day.",
            crisis: false,
            escalated: false,
        };
    }
}
