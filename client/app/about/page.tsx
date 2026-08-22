import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { HeartPulse, ShieldCheck, Sparkles, Users } from "lucide-react";

export async function generateMetadata() {
    const t = await getTranslations("staticPages.about");
    return {
        title: "About Us",
        description: t("subtitle"),
    };
}

const VALUES = [
    {
        icon: HeartPulse,
        title: "Care first",
        body: "Every feature starts with one question: does this help someone feel better? Clinical safety and human dignity come before engagement metrics.",
    },
    {
        icon: ShieldCheck,
        title: "Privacy by design",
        body: "Health-related data deserves the highest protection. We build encryption, strict access control, and data minimization into every layer.",
    },
    {
        icon: Sparkles,
        title: "AI that empowers",
        body: "AI prepares sessions, surfaces patterns, and suggests wellness practices — but it never replaces the judgment of a licensed professional.",
    },
    {
        icon: Users,
        title: "Accessible support",
        body: "We lower the barriers to starting therapy: fast matching, flexible consultation modes, and continuous touchpoints between sessions.",
    },
];

export default async function AboutPage() {
    const t = await getTranslations("staticPages.about");
    return (
        <main className="min-h-screen bg-gray-50">
            <div className="max-w-5xl mx-auto px-4 md:px-8 py-20">
                <div className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-[2rem] p-10 md:p-16 mb-12 text-center">
                    <h1 className="text-4xl md:text-5xl font-black text-white font-outfit mb-4">
                        {t("title")} <span className="text-indigo-200">{t("titleAccent")}</span>
                    </h1>
                    <p className="text-indigo-100 max-w-2xl mx-auto text-lg leading-relaxed">
                        {t("subtitle")}
                    </p>
                </div>

                <h2 className="text-2xl font-extrabold text-gray-900 mb-6">What we believe</h2>
                <div className="grid md:grid-cols-2 gap-4 mb-12">
                    {VALUES.map((v) => (
                        <div key={v.title} className="bg-white rounded-3xl border border-gray-100 p-6">
                            <v.icon className="w-6 h-6 text-indigo-500 mb-4" />
                            <h3 className="font-extrabold text-gray-900 mb-2">{v.title}</h3>
                            <p className="text-sm text-gray-500 leading-relaxed">{v.body}</p>
                        </div>
                    ))}
                </div>

                <div className="bg-white rounded-3xl border border-gray-100 p-8 md:p-12 mb-12">
                    <h2 className="text-2xl font-extrabold text-gray-900 mb-4">Our story</h2>
                    <p className="text-gray-600 leading-relaxed mb-4">
                        MindEase was founded on a simple observation: most people wait months — or years — before
                        seeking help, and when they finally book a session, precious time is spent on paperwork
                        instead of healing.
                    </p>
                    <p className="text-gray-600 leading-relaxed">
                        We built a platform where patients reflect before sessions with AI-guided questions,
                        doctors arrive with a compiled clinical briefing, and mood tracking keeps care alive
                        between consultations. Low friction to match, high quality in every session.
                    </p>
                </div>

                <div className="text-center">
                    <p className="text-gray-600 mb-6 font-medium">Ready to start your journey?</p>
                    <div className="flex flex-col sm:flex-row justify-center gap-4">
                        <Link href="/doctors" className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all">
                            Find a Psychologist
                        </Link>
                        <Link href="/faq" className="px-8 py-4 bg-white text-indigo-600 border border-indigo-200 rounded-2xl font-black hover:bg-indigo-50 transition-all">
                            Read the FAQ
                        </Link>
                    </div>
                </div>
            </div>
        </main>
    );
}
