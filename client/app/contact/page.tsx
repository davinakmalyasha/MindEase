import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Mail, Phone, MapPin, Clock, MessagesSquare } from "lucide-react";

export async function generateMetadata() {
    const t = await getTranslations("staticPages.contact");
    return {
        title: "Contact Us",
        description: t("subtitle"),
    };
}

const CHANNELS = [
    {
        icon: MessagesSquare,
        title: "General support",
        description: "Questions about your account, bookings, or the platform.",
        value: "support@mindease.id",
        href: "mailto:support@mindease.id",
        cta: "Email support",
    },
    {
        icon: Mail,
        title: "Psychologist registration",
        description: "Interested in joining our network of licensed professionals?",
        value: "doctors@mindease.id",
        href: "mailto:doctors@mindease.id",
        cta: "Email doctors team",
    },
    {
        icon: Phone,
        title: "Phone (business hours)",
        description: "Monday–Friday, 09:00–17:00 WIB (Indonesia).",
        value: "+62 812 3456 7890",
        href: "tel:+6281234567890",
        cta: "Call us",
    },
    {
        icon: MapPin,
        title: "Office",
        description: "By appointment only.",
        value: "Sudirman City, Jakarta CBD Area, Indonesia",
        cta: "Plan a visit",
    },
    {
        icon: Clock,
        title: "Response time",
        description: "We usually reply within 1 business day. Urgent or crisis matters should never wait for email — see below.",
        value: "1 business day",
        cta: "View crisis hotlines",
    },
];

export default async function ContactPage() {
    const t = await getTranslations("staticPages.contact");
    return (
        <main className="min-h-screen bg-gray-50">
            <div className="max-w-5xl mx-auto px-4 md:px-8 py-20">
                <div className="bg-white rounded-[2rem] border border-gray-100 shadow-sm p-8 md:p-12 mb-10">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center">
                            <Mail className="w-6 h-6 text-indigo-600" />
                        </div>
                        <span className="text-sm font-black uppercase tracking-widest text-indigo-600">Contact</span>
                    </div>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 font-outfit mb-4">
                        {t("title")} <span className="text-indigo-600">{t("titleAccent")}</span>
                    </h1>
                    <p className="text-gray-500 max-w-xl">
                        {t("subtitle")}
                    </p>
                </div>

                <div className="grid md:grid-cols-2 gap-4 mb-10">
                    {CHANNELS.map((c) => (
                        <div key={c.title} className="bg-white rounded-3xl border border-gray-100 p-6 flex flex-col">
                            <div className="flex items-center gap-3 mb-3">
                                <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                                    <c.icon className="w-5 h-5" />
                                </div>
                                <h2 className="font-extrabold text-gray-900">{c.title}</h2>
                            </div>
                            <p className="text-sm text-gray-500 leading-relaxed mb-4 flex-1">{c.description}</p>
                            <div className="flex items-center justify-between gap-4">
                                <span className="font-bold text-gray-900 text-sm">{c.value}</span>
                                {c.href ? (
                                    <Link
                                        href={c.href}
                                        className="text-xs font-black text-indigo-600 hover:text-indigo-700 underline underline-offset-4 shrink-0"
                                    >
                                        {c.cta} →
                                    </Link>
                                ) : (
                                    <Link
                                        href="/crisis"
                                        className="text-xs font-black text-rose-600 hover:text-rose-700 underline underline-offset-4 shrink-0"
                                    >
                                        {c.cta} →
                                    </Link>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="bg-rose-50 border border-rose-200 rounded-3xl p-8 text-center">
                    <h2 className="text-lg font-extrabold text-rose-700 mb-2">In crisis or in danger right now?</h2>
                    <p className="text-rose-600 mb-5">
                        Email is not a crisis service. Call 112 (Indonesia) or a hotline immediately.
                    </p>
                    <Link
                        href="/crisis"
                        className="inline-block px-8 py-3.5 bg-rose-600 text-white rounded-2xl font-black hover:bg-rose-700 transition-all"
                    >
                        View Crisis Hotlines
                    </Link>
                </div>
            </div>
        </main>
    );
}
