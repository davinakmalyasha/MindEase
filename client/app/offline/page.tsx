import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { WifiOff, HeartHandshake, PhoneCall } from "lucide-react";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("staticPages.offline");
    return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: false } };
}

/**
 * Offline fallback.
 *
 * Deliberately leads with the crisis numbers rather than a dead end: a user who
 * loses connectivity mid-session may be the person most in need of help, and
 * `tel:` links work with no data plan.
 */
export default async function OfflinePage() {
    const t = await getTranslations("staticPages.offline");
    const hotlines = t.raw("hotlines") as { name: string; dial: string; contact: string }[];

    return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-4 py-28 text-center">
            <div
                aria-hidden="true"
                className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-amber-100 bg-amber-50"
            >
                <WifiOff className="h-10 w-10 text-amber-600" />
            </div>

            <h1 className="mb-3 text-3xl font-extrabold text-gray-900 dark:text-gray-50">{t("title")}</h1>
            <p className="mb-8 max-w-lg text-gray-600 dark:text-gray-300">{t("body")}</p>

            <Link
                href="/dashboard"
                className="mb-10 rounded-2xl bg-indigo-600 px-6 py-3 font-bold text-white transition-colors hover:bg-indigo-700"
            >
                {t("retry")}
            </Link>

            <section
                aria-labelledby="offline-crisis-heading"
                className="w-full rounded-3xl border border-rose-100 bg-rose-50/60 p-6 text-left"
            >
                <h2
                    id="offline-crisis-heading"
                    className="mb-2 flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-gray-50"
                >
                    <HeartHandshake className="h-5 w-5 text-rose-500" aria-hidden="true" />
                    {t("crisisTitle")}
                </h2>
                <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{t("crisisBody")}</p>

                <ul className="space-y-2">
                    {hotlines.map((h) => (
                        <li
                            key={h.name}
                            className="flex items-center justify-between gap-3 rounded-xl bg-white/80 p-3 dark:bg-gray-800/60"
                        >
                            <span className="min-w-0 text-sm font-bold text-gray-700 dark:text-gray-200">
                                {h.name}
                            </span>
                            <a
                                href={`tel:${h.dial}`}
                                className="flex shrink-0 items-center gap-1 text-sm font-bold text-emerald-700 hover:underline dark:text-emerald-400"
                            >
                                <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
                                {h.contact}
                            </a>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
}
