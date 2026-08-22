import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Scale } from "lucide-react";

export async function generateMetadata() {
    const t = await getTranslations("staticPages.terms");
    return {
        title: "Terms of Service",
        description: t("subtitle"),
    };
}

const SECTIONS = [
    {
        title: "1. Acceptance of terms",
        body: "By creating an account or using MindEase, you agree to these Terms of Service. If you do not agree, please do not use the platform. These terms apply to all users: patients, psychologists (\"doctors\"), and administrators.",
    },
    {
        title: "2. Eligibility",
        body: "You must be at least 18 years old to use MindEase. By registering you confirm that the information you provide is accurate and that you are legally able to enter into this agreement. Psychologists registering must hold valid professional credentials and must provide true information about their qualifications and licensing.",
    },
    {
        title: "3. Nature of services & disclaimer",
        body: "MindEase facilitates access to licensed psychological professionals and provides wellness tools and AI-assisted preparation features. MindEase is not a medical institution. AI-generated content (pre-session questions, clinical briefings, wellness suggestions) is provided for guidance only and does not constitute diagnosis, treatment, or medical advice. In a crisis or emergency, call local emergency services immediately — MindEase is not an emergency service.",
    },
    {
        title: "4. Accounts & security",
        body: "You are responsible for safeguarding your login credentials and for all activity under your account. Notify us immediately of unauthorized access. We may suspend or close accounts that violate these terms, including accounts involved in fraudulent booking activity, harassment, or abuse.",
    },
    {
        title: "5. Booking & cancellation",
        body: "Appointments are confirmed at the psychologist's discretion. You may cancel appointments according to the cancellation options provided in the platform. Repeated no-shows or last-minute cancellations may result in restrictions. Psychologists may accept, reschedule, or cancel sessions in accordance with their professional judgment.",
    },
    {
        title: "6. Conduct",
        body: "You agree not to: use the platform for unlawful purposes; harass, threaten, or abuse users or professionals; misrepresent your identity or qualifications; attempt to access another user's data or disrupt platform operation; misuse AI features or bypass security measures. Confidentiality: do not share content from your sessions without written consent.",
    },
    {
        title: "7. Fees & payments",
        body: "Consultation fees are set by each psychologist and displayed on their profile. Payment processing, where offered, is handled by trusted payment providers. Where payment is arranged directly between patient and psychologist (e.g., offline), MindEase is not a party to that transaction.",
    },
    {
        title: "8. Reviews",
        body: "Reviews must be honest and relate to your actual session. We may remove reviews that are defamatory, contain personal data about third parties, or otherwise violate these terms.",
    },
    {
        title: "9. Intellectual property",
        body: "The MindEase platform, branding, and software are owned by MindEase. You may not copy, modify, or reverse-engineer the platform. Content you submit (reflections, reviews, messages) remains yours, and you grant us a limited license to store and process it to operate the service.",
    },
    {
        title: "10. Limitation of liability",
        body: "To the maximum extent permitted by law, MindEase shall not be liable for indirect, incidental, or consequential damages arising from your use of the platform, including reliance on AI-generated content. Clinical care is provided by the psychologist, who is solely responsible for the treatment and advice they provide.",
    },
    {
        title: "11. Termination",
        body: "You may delete your account at any time from profile settings, which removes your personal data in accordance with our Privacy Policy. We may suspend accounts for breaches of these terms, fraud, or legal requirements.",
    },
    {
        title: "12. Changes to these terms",
        body: "We may update these terms periodically. Material changes will be announced in-app or by email. Continued use after changes take effect constitutes acceptance.",
    },
    {
        title: "13. Contact",
        body: "For questions about these terms: support@mindease.id.",
    },
];

export default async function TermsPage() {
    const t = await getTranslations("staticPages.terms");
    return (
        <main className="min-h-screen bg-gray-50">
            <div className="max-w-4xl mx-auto px-4 md:px-8 py-20">
                <div className="bg-white rounded-[2rem] border border-gray-100 shadow-sm p-8 md:p-12 mb-10">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center">
                            <Scale className="w-6 h-6 text-indigo-600" />
                        </div>
                        <span className="text-sm font-black uppercase tracking-widest text-indigo-600">Terms of Service</span>
                    </div>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 font-outfit mb-4">
                        {t("title")} <span className="text-indigo-600">{t("titleAccent")}</span>
                    </h1>
                    <p className="text-gray-500">{t("subtitle")}</p>
                </div>

                <div className="space-y-8">
                    {SECTIONS.map((s) => (
                        <div key={s.title} className="bg-white rounded-3xl border border-gray-100 p-8">
                            <h2 className="text-xl font-extrabold text-gray-900 mb-3">{s.title}</h2>
                            <p className="text-gray-600 leading-relaxed">{s.body}</p>
                        </div>
                    ))}
                </div>

                <div className="mt-10 bg-indigo-50 rounded-3xl p-8 text-center">
                    <p className="text-gray-600 mb-4">
                        Have questions about our terms?
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
