"use client";

import Link from "next/link";
import { CalendarCheck, HeartPulse, LifeBuoy, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";

// Previously six invented testimonials with invented names, roles and star
// ratings — including a "telepathy consultations" quote. A mental-health
// platform must not fabricate social proof, so this section now describes
// what the product actually does, with links to the real pages. Copy lives in
// the locale catalog, not in JSX.
const VALUE_PROPS = [
    {
        icon: CalendarCheck,
        titleKey: "bookTitle",
        bodyKey: "bookBody",
        href: "/appointments",
        ctaKey: "bookCta",
    },
    {
        icon: HeartPulse,
        titleKey: "trackTitle",
        bodyKey: "trackBody",
        href: "/dashboard/mood",
        ctaKey: "trackCta",
    },
    {
        icon: LifeBuoy,
        titleKey: "crisisTitle",
        bodyKey: "crisisBody",
        href: "/crisis",
        ctaKey: "crisisCta",
    },
] as const;

export default function ReviewsSection() {
    const t = useTranslations("home.valueProps");
    return (
        <section className="py-32 w-full bg-slate-50 dark:bg-gray-900 relative overflow-hidden">
            {/* Background Decorative Elements */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-40">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-100 rounded-full blur-[120px]"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-100 rounded-full blur-[120px]"></div>
            </div>

            <div className="max-w-7xl mx-auto px-4 md:px-8 relative z-10">
                <div className="text-center mb-20 space-y-4">
                    <motion.span
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="text-indigo-600 dark:text-indigo-400 font-black tracking-[0.3em] uppercase text-xs"
                    >
                        {t("kicker")}
                    </motion.span>
                    <motion.h2
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.1 }}
                        className="text-4xl md:text-6xl font-black text-gray-900 dark:text-white font-outfit"
                    >
                        {t("headingA")} <span className="text-indigo-600 dark:text-indigo-400">{t("headingB")}</span>
                    </motion.h2>
                    <motion.p
                        initial={{ opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.2 }}
                        className="text-gray-500 dark:text-gray-400 font-medium max-w-2xl mx-auto leading-relaxed"
                    >
                        {t("sub")}
                    </motion.p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {VALUE_PROPS.map((item, idx) => (
                        <motion.div
                            key={item.titleKey}
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: idx * 0.1, duration: 0.5 }}
                            className="group"
                        >
                            <div className="h-full bg-white dark:bg-gray-800 p-8 rounded-[2.5rem] border border-gray-100 dark:border-gray-700 shadow-xl shadow-indigo-500/5 hover:shadow-2xl hover:shadow-indigo-500/10 transition-all duration-500 hover:-translate-y-2 relative overflow-hidden">
                                {/* Floating Icon/Badge for premium feel */}
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-50 dark:bg-indigo-950 rounded-full opacity-30 group-hover:scale-150 transition-transform duration-700"></div>

                                <div className="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-5">
                                    <item.icon className="w-6 h-6" aria-hidden="true" />
                                </div>
                                <h3 className="text-xl font-extrabold text-gray-900 dark:text-white mb-2">
                                    {t(item.titleKey)}
                                </h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-6">
                                    {t(item.bodyKey)}
                                </p>
                                <Link
                                    href={item.href}
                                    className="inline-flex items-center gap-1.5 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                                >
                                    {t(item.ctaKey)}
                                    <ArrowRight className="w-4 h-4" aria-hidden="true" />
                                </Link>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    );
}
