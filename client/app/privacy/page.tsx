import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";

export async function generateMetadata() {
    const t = await getTranslations("staticPages.privacy");
    return {
        title: "Privacy Policy",
        description: t("subtitle"),
    };
}

/**
 * `"10. Cookies & storage"` -> `"cookies-storage"`.
 *
 * Sections used to render bare `<div>`s with no `id`, so the cookie banner's
 * `/privacy#cookies` link and the footer's both resolved to nothing. The anchor
 * is derived from the heading rather than hand-written, so it cannot drift from
 * the content, and `&` is dropped so the common case reads as one word.
 *
 * The leading section number is stripped, which is why inserting the new
 * "Video consultations" section did not break the cookie banner's anchor.
 */
const slugify = (title: string) =>
    title
        .replace(/^\d+\.\s*/, "")
        .toLowerCase()
        .replace(/&/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

const SECTIONS = [
    {
        title: "1. Who we are",
        body: "MindEase (\"we\", \"us\", \"our\") operates a mental health consultation platform connecting patients with licensed psychologists. This policy explains how we handle your personal data when you use our website and services.",
    },
    {
        title: "2. Data we collect",
        body: "We collect: (a) account data — name, email, phone number, password (hashed), role; (b) profile data — avatar, biography, specialty, and consultation pricing for doctors; (c) health-related data — mood entries, pre-session reflections, appointment notes, and consultation details, which are treated as sensitive data and handled with extra care; (d) technical data — IP address, browser type, and usage logs, used for security and performance.",
    },
    {
        title: "3. How we use your data",
        body: "We use your data to: provide and operate the platform (booking, messaging, notifications); enable AI-assisted features such as pre-session questions and clinical briefings (only for your assigned doctor); send service and booking-related emails; ensure security and prevent fraud; and improve the service with aggregated, anonymized analytics.",
    },
    {
        title: "4. How we share your data",
        body: "Your data is visible to: the psychologist you book with (appointment details, mood history within 14 days, and pre-session answers, only for your booked sessions); system administrators for platform operations; and processors such as our hosting provider, email provider, and AI provider — under contract and only for the purposes above. We never sell your personal data.",
    },
    {
        title: "5. AI processing",
        body: "AI features (question generation, clinical briefings, wellness suggestions) may send your mood entries, notes, and pre-session answers to our AI provider for processing. AI output is for guidance only and is not a diagnosis. You may decline to use AI-assisted features without affecting core services. Always review our AI disclaimers before relying on AI-generated content.",
    },
    {
        // Previously absent entirely. Every consultation's audio and video was
        // being relayed through a third party's public infrastructure, with
        // nothing in this policy saying so - which is a disclosure gap, not a
        // configuration detail.
        title: "6. Video consultations",
        body: "Video and voice consultations are carried by a third-party real-time media provider acting as our processor, under contract and limited to delivering the call. We do not record consultations, and the provider is not authorised to retain audio or video beyond the session. Access to a consultation room requires a short-lived credential issued to you individually when you open the room; a link alone is not sufficient, and the credential expires when the scheduled session ends. If a deployment is running an older configuration where the room is instead a shared link, the consultation screen will say so before you join.",
    },
    {
        title: "7. Security",
        body: "We protect your data with encryption in transit and at rest, Argon2 password hashing, short-lived session tokens with rotation, CSRF protection, and strict access controls. Health-related data is only accessible to the relevant psychologist and administrators bound by confidentiality obligations.",
    },
    {
        title: "8. Retention",
        body: "We retain your data while your account is active and as long as needed to provide the service or comply with legal obligations. You can export a copy of everything below at any time, and you should export before you delete. Deletion purges your account, profile, journal entries, mood logs and their factor tags, screening answers, pre-session reflections, messages, reviews, safety plan, care plan and notifications. What is retained is limited to two things, both in anonymised form, where the record belongs to a clinician rather than to you: appointment history, and clinical safety records — for example, that a screening answer triggered a clinician alert — because the fact that a disclosure happened is clinically relevant to whoever treats you next. Your name and email are replaced with a random identifier, so nothing identifying survives on those rows.",
    },
    {
        title: "9. Your rights",
        body: "You may: access, correct, or update your data from your profile page; request a copy of your data (data portability); delete your account and associated personal data from your profile settings; withdraw consent for AI features at any time. To exercise any right, contact us at support@mindease.id.",
    },
    {
        title: "10. Cookies & storage",
        body: "We use essential cookies for authentication (login session), security (CSRF token), and preferences (language, theme). We do not use third-party advertising cookies. You can manage cookies through your browser, but disabling essential cookies will prevent you from using the platform.",
    },
    {
        title: "11. Children's privacy",
        body: "Our services are intended for users aged 18 and above. We do not knowingly collect data from children under 18. If you believe a child has provided us personal data, contact us and we will delete it.",
    },
    {
        title: "12. Changes to this policy",
        body: "We may update this policy from time to time. Material changes will be announced in-app and by email where required. Continued use of the platform after changes constitutes acceptance of the revised policy.",
    },
    {
        title: "12. Contact",
        body: "For privacy questions or requests: support@mindease.id. We respond to privacy requests within 30 days.",
    },
];

export default async function PrivacyPage() {
    const t = await getTranslations("staticPages.privacy");
    return (
        <main className="min-h-screen bg-gray-50">
            <div className="max-w-4xl mx-auto px-4 md:px-8 py-20">
                <div className="bg-white rounded-[2rem] border border-gray-100 shadow-sm p-8 md:p-12 mb-10">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center">
                            <ShieldCheck className="w-6 h-6 text-indigo-600" />
                        </div>
                        <span className="text-sm font-black uppercase tracking-widest text-indigo-600">Privacy Policy</span>
                    </div>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 font-outfit mb-4">
                        {t("title")} <span className="text-indigo-600">{t("titleAccent")}</span>
                    </h1>
                    <p className="text-gray-500">{t("subtitle")}</p>
                </div>

                <div className="space-y-8">
                    {SECTIONS.map((s) => (
                        <section
                            key={s.title}
                            // Anchors are derived from the heading so the cookie
                            // banner's `/privacy#cookies` link and the footer's
                            // resolve to a real element. They previously pointed at
                            // nothing, because the sections rendered bare `<div>`s
                            // with no `id` at all.
                            id={slugify(s.title)}
                            className="bg-white rounded-3xl border border-gray-100 p-8 scroll-mt-28"
                        >
                            <h2 className="text-xl font-extrabold text-gray-900 mb-3">{s.title}</h2>
                            <p className="text-gray-600 leading-relaxed">{s.body}</p>
                        </section>
                    ))}
                </div>

                <div className="mt-10 bg-indigo-50 rounded-3xl p-8 text-center">
                    <p className="text-gray-600 mb-4">
                        Questions about your data? We are happy to help.
                    </p>
                    <Link
                        href="/contact"
                        className="inline-block px-8 py-3.5 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all"
                    >
                        Contact Us
                    </Link>
                </div>
            </div>
        </main>
    );
}
