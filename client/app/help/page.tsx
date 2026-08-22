"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
    Calendar,
    HeartPulse,
    MessagesSquare,
    UserCircle2,
    Sparkles,
    ShieldCheck,
    HeartHandshake,
    Search,
    Mail,
    MessageCircle,
    Clock,
} from "lucide-react";

const TOPICS = [
    {
        icon: Calendar,
        title: "Booking a session",
        href: "/faq",
        keywords: ["book", "booking", "appointment", "slot", "schedule", "reservasi", "jadwal"],
        body: "Choose a doctor, pick a slot, fill in your details, and confirm. Here's how the flow works.",
    },
    {
        icon: HeartPulse,
        title: "Mood tracking & wellness",
        href: "/faq",
        keywords: ["mood", "wellness", "tracker", "streak", "log", "suasana"],
        body: "Log your daily mood, view trends and streaks, and get personalized wellness suggestions.",
    },
    {
        icon: MessagesSquare,
        title: "Messaging your doctor",
        href: "/messages",
        keywords: ["message", "chat", "messaging", "pesan", "wa", "whatsapp"],
        body: "Chat with your doctor in real time after your booking is confirmed.",
    },
    {
        icon: Sparkles,
        title: "AI features",
        href: "/faq",
        keywords: ["ai", "gemini", "reflection", "pre-session", "briefing", "question"],
        body: "Pre-session questions, clinical briefings, and wellness suggestions — what they do and how to use them safely.",
    },
    {
        icon: UserCircle2,
        title: "Profile & account",
        href: "/dashboard/profile",
        keywords: ["profile", "account", "avatar", "password", "2fa", "delete"],
        body: "Update your info, avatar, phone number, security settings, and delete your account.",
    },
    {
        icon: ShieldCheck,
        title: "Privacy & data",
        href: "/privacy",
        keywords: ["privacy", "data", "gdpr", "security", "pribadi", "aman"],
        body: "How we protect your health-related data and your rights as a user.",
    },
    {
        icon: HeartHandshake,
        title: "Crisis support",
        href: "/crisis",
        keywords: ["crisis", "emergency", "hotline", "suicide", "danger", "darurat", "krisis"],
        body: "Free, confidential hotlines available 24/7. If you are in crisis, go here first.",
    },
];

const STEPS = [
    {
        step: "1",
        title: "Create an account",
        body: "Sign up as a patient or psychologist in under a minute — email or Google.",
    },
    {
        step: "2",
        title: "Find the right doctor",
        body: "Filter by specialty, price, and experience, then read profiles and reviews.",
    },
    {
        step: "3",
        title: "Book & prepare",
        body: "Pick a slot, answer a few questions, and complete your pre-session reflections when confirmed.",
    },
    {
        step: "4",
        title: "Consult & continue",
        body: "Meet your doctor via video, voice, or chat — then keep tracking your mood between sessions.",
    },
];

export default function HelpPage() {
    const t = useTranslations("staticPages.help");
    const [query, setQuery] = useState("");

    const filtered = TOPICS.filter((t) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return (
            t.title.toLowerCase().includes(q) ||
            t.body.toLowerCase().includes(q) ||
            t.keywords.some((k) => k.includes(q))
        );
    });

    return (
        <main className="min-h-screen bg-gray-50">
            <div className="max-w-5xl mx-auto px-4 md:px-8 py-20">
                <div className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-[2rem] p-10 md:p-14 mb-12">
                    <h1 className="text-4xl md:text-5xl font-black text-white font-outfit mb-4">
                        {t("title")}
                    </h1>
                    <p className="text-indigo-100 max-w-xl text-lg mb-8">
                        {t("subtitle")}
                    </p>
                    <div className="relative max-w-xl">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search help topics… (e.g. booking, privacy, reschedule)"
                            className="w-full pl-12 pr-4 py-4 rounded-2xl bg-white text-gray-900 placeholder-gray-400 font-medium shadow-lg outline-none focus:ring-4 focus:ring-white/30 transition-all"
                        />
                    </div>
                </div>

                {query && filtered.length === 0 ? (
                    <div className="bg-white rounded-3xl border border-gray-100 p-12 text-center mb-12">
                        <p className="text-gray-500 font-medium mb-3">No topics match &quot;{query}&quot;.</p>
                        <p className="text-sm text-gray-400 mb-6">
                            The support assistant can answer your question right now — or our team will help.
                        </p>
                        <div className="flex flex-col sm:flex-row justify-center gap-4">
                            <Link href="/contact" className="px-8 py-3.5 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all">
                                Contact Customer Service
                            </Link>
                        </div>
                    </div>
                ) : (
                    <div className="grid md:grid-cols-2 gap-4 mb-12">
                        {filtered.map((t) => (
                            <Link
                                key={t.title}
                                href={t.href}
                                className="bg-white rounded-3xl border border-gray-100 p-6 hover:border-indigo-200 hover:shadow-md transition-all group"
                            >
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
                                        <t.icon className="w-5 h-5" />
                                    </div>
                                    <h3 className="font-extrabold text-gray-900">{t.title}</h3>
                                </div>
                                <p className="text-sm text-gray-500 leading-relaxed">{t.body}</p>
                            </Link>
                        ))}
                    </div>
                )}

                <h2 className="text-2xl font-extrabold text-gray-900 mb-6">Getting started</h2>
                <div className="grid md:grid-cols-4 gap-4 mb-12">
                    {STEPS.map((s) => (
                        <div key={s.step} className="bg-white rounded-3xl border border-gray-100 p-6">
                            <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white font-black flex items-center justify-center mb-4">
                                {s.step}
                            </div>
                            <h3 className="font-extrabold text-gray-900 mb-2 text-sm">{s.title}</h3>
                            <p className="text-xs text-gray-500 leading-relaxed">{s.body}</p>
                        </div>
                    ))}
                </div>

                <div className="bg-white rounded-3xl border border-gray-100 p-8 md:p-10 mb-12">
                    <h2 className="text-xl font-extrabold text-gray-900 mb-2">
                        Talk to customer service
                    </h2>
                    <p className="text-gray-500 mb-6">
                        Our support team replies within one business day. For urgent or crisis matters,
                        use the crisis hotlines instead.
                    </p>
                    <div className="grid sm:grid-cols-2 gap-4 mb-6">
                        <div className="flex items-start gap-4 p-5 rounded-2xl bg-indigo-50">
                            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0">
                                <Mail className="w-5 h-5" />
                            </div>
                            <div>
                                <p className="font-bold text-gray-900 text-sm">Email</p>
                                <p className="text-xs text-gray-500 mb-2">support@mindease.id</p>
                                <a href="mailto:support@mindease.id" className="text-xs font-black text-indigo-600 underline underline-offset-4">
                                    Send an email →
                                </a>
                            </div>
                        </div>
                        <div className="flex items-start gap-4 p-5 rounded-2xl bg-emerald-50">
                            <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                                <MessageCircle className="w-5 h-5" />
                            </div>
                            <div>
                                <p className="font-bold text-gray-900 text-sm">WhatsApp</p>
                                <p className="text-xs text-gray-500 mb-2">+62 812 3456 7890</p>
                                <a href="https://wa.me/6281234567890" target="_blank" rel="noopener noreferrer" className="text-xs font-black text-emerald-600 underline underline-offset-4">
                                    Open WhatsApp →
                                </a>
                            </div>
                        </div>
                        <div className="flex items-start gap-4 p-5 rounded-2xl bg-gray-50 sm:col-span-2">
                            <div className="w-10 h-10 rounded-xl bg-gray-700 text-white flex items-center justify-center shrink-0">
                                <Clock className="w-5 h-5" />
                            </div>
                            <div>
                                <p className="font-bold text-gray-900 text-sm">Response time</p>
                                <p className="text-xs text-gray-500">
                                    Monday–Friday, 09:00–17:00 WIB. We usually reply within one business day.
                                    Tip: the AI assistant in the bottom-right corner answers instantly for common questions.
                                </p>
                            </div>
                        </div>
                    </div>
                    <Link href="/contact" className="inline-block px-8 py-3.5 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all">
                        All contact options
                    </Link>
                </div>

                <div className="bg-rose-50 border border-rose-200 rounded-3xl p-8 text-center">
                    <h2 className="text-lg font-extrabold text-rose-700 mb-2">In crisis or in danger right now?</h2>
                    <p className="text-rose-600 mb-5">
                        Do not wait for email or chat — call 112 (Indonesia) or a hotline immediately.
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
