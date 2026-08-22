"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronDown, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const FAQS = [
    {
        q: "How do I book a consultation?",
        a: "Browse our doctor directory, choose a psychologist whose specialty and price fit you, pick an available date and time slot, fill in a short form about your situation, and confirm. The doctor will accept or reschedule your booking.",
    },
    {
        q: "What consultation modes are available?",
        a: "Video call, voice call, and text chat. You choose the mode during booking. Confirmed appointments unlock direct WhatsApp contact with your doctor.",
    },
    {
        q: "Are the psychologists licensed?",
        a: "Psychologists on MindEase register with their professional details, and doctor profiles display their specialty, experience, and pricing. Always review a doctor's profile and credentials before booking.",
    },
    {
        q: "What are pre-session reflections?",
        a: "Once a booking is confirmed, our AI generates a few compassionate questions based on your situation. Answering them helps your doctor prepare for your session — your answers are only visible to you and your doctor.",
    },
    {
        q: "What is an AI clinical briefing?",
        a: "A concise summary of your recent mood history and pre-session answers, generated for your doctor before the session. It helps the doctor focus on what matters most. AI content is guidance only, not a diagnosis.",
    },
    {
        q: "Is my data private?",
        a: "Yes. Health-related data is encrypted, access is strictly limited to you and your assigned doctor, and we never sell personal data. See our Privacy Policy for full details.",
    },
    {
        q: "Is MindEase an emergency service?",
        a: "No. MindEase is not an emergency service. If you are in crisis or immediate danger, call your local emergency number right away (112 in Indonesia) or a crisis hotline — see our Crisis Support page.",
    },
    {
        q: "Can I cancel or reschedule?",
        a: "Yes. You can cancel pending or confirmed appointments from your appointments page. Rescheduling options are available depending on the appointment state.",
    },
    {
        q: "How does mood tracking work?",
        a: "Log how you feel on a 1–5 scale each day. MindEase computes your 30-day average, logging streak, and emotional trend, and can suggest personalized wellness activities.",
    },
    {
        q: "How do I delete my account?",
        a: "Go to Profile → account settings and choose delete account. We purge your personal data and anonymize historical records, in line with our Privacy Policy.",
    },
    {
        q: "Do I need to register to browse doctors?",
        a: "No — the doctor directory is public. You need an account to book appointments, chat, and use mood tracking.",
    },
    {
        q: "What does it cost?",
        a: "Each psychologist sets their own consultation price, shown on their profile. There are no hidden platform fees for patients. Payment is arranged per your chosen doctor's terms.",
    },
];

export default function FaqPage() {
    const t = useTranslations("staticPages.faq");
    const [open, setOpen] = useState<number | null>(0);

    return (
        <main className="min-h-screen bg-gray-50">
            <div className="max-w-4xl mx-auto px-4 md:px-8 py-20">
                <div className="bg-white rounded-[2rem] border border-gray-100 shadow-sm p-8 md:p-12 mb-10">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center">
                            <HelpCircle className="w-6 h-6 text-indigo-600" />
                        </div>
                        <span className="text-sm font-black uppercase tracking-widest text-indigo-600">FAQ</span>
                    </div>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 font-outfit mb-4">
                        {t("title")} <span className="text-indigo-600">{t("titleAccent")}</span>
                    </h1>
                    <p className="text-gray-500">
                        {t("subtitle")}
                    </p>
                </div>

                <div className="space-y-3">
                    {FAQS.map((f, i) => (
                        <div key={f.q} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                            <button
                                onClick={() => setOpen(open === i ? null : i)}
                                className="w-full flex items-center justify-between gap-4 px-6 py-5 text-left font-bold text-gray-900 hover:bg-indigo-50/50 transition-colors"
                            >
                                <span>{f.q}</span>
                                <ChevronDown className={cn("w-5 h-5 text-indigo-500 shrink-0 transition-transform", open === i && "rotate-180")} />
                            </button>
                            {open === i && (
                                <p className="px-6 pb-5 text-gray-600 leading-relaxed">{f.a}</p>
                            )}
                        </div>
                    ))}
                </div>

                <div className="mt-10 bg-indigo-50 rounded-3xl p-8 text-center">
                    <p className="text-gray-600 mb-4 font-medium">Still have questions?</p>
                    <div className="flex flex-col sm:flex-row justify-center gap-4">
                        <Link href="/contact" className="px-8 py-3.5 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all">
                            Contact Us
                        </Link>
                        <Link href="/help" className="px-8 py-3.5 bg-white text-indigo-600 border border-indigo-200 rounded-2xl font-black hover:bg-indigo-50 transition-all">
                            Help Center
                        </Link>
                    </div>
                </div>
            </div>
        </main>
    );
}
