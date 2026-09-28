import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PhoneCall, HeartHandshake, ShieldAlert, MessageCircle } from "lucide-react";

export async function generateMetadata() {
    const t = await getTranslations("staticPages.crisis");
    return {
        title: t("metaTitle"),
        description: t("metaDescription"),
    };
}

export default async function CrisisPage() {
    const t = await getTranslations("staticPages.crisis");
    const hotlines = t.raw("hotlines") as { name: string; number: string; note: string; whatsapp?: boolean }[];
    const steps = t.raw("steps") as { title: string; description: string }[];

    const stepIcons = [PhoneCall, HeartHandshake, ShieldAlert];

    /**
     * Voice lines must use `tel:`. The page previously built a WhatsApp deep
     * link from every number, which turned the national emergency line into
     * `wa.me/112119` — a link that goes nowhere. A `tel:` link also works with
     * no data plan, which matters for the users most likely to need it.
     */
    const dialHref = (h: { number: string; whatsapp?: boolean }) => {
        if (h.whatsapp) {
            const digits = h.number.replace(/\D/g, "");
            // WhatsApp needs a country code with no leading zero.
            const international = digits.replace(/^0+/, "");
            return `https://wa.me/${international}`;
        }
        return `tel:${h.number.replace(/[^\d+]/g, "")}`;
    };

    return (
        <main className="min-h-screen bg-white pt-28 pb-16 px-4 md:px-8 max-w-4xl mx-auto">
            <div className="text-center mb-12">
                <div className="w-20 h-20 rounded-3xl bg-rose-50 border border-rose-100 flex items-center justify-center mx-auto mb-6">
                    <HeartHandshake className="w-10 h-10 text-rose-500" />
                </div>
                <h1 className="text-4xl md:text-5xl font-extrabold text-gray-900 font-outfit mb-4">{t("title")}</h1>
                <p className="text-gray-500 text-lg max-w-2xl mx-auto">{t("subtitle")}</p>
            </div>

            <section className="mb-14">
                <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                    <ShieldAlert className="w-6 h-6 text-rose-500" /> {t("immediateSteps")}
                </h2>
                <div className="grid md:grid-cols-3 gap-5">
                    {steps.map((step, i) => {
                        const Icon = stepIcons[i] || MessageCircle;
                        return (
                            <div key={step.title} className="p-6 bg-rose-50/40 border border-rose-100/60 rounded-3xl">
                                <div className="w-11 h-11 rounded-2xl bg-rose-500 text-white flex items-center justify-center mb-4">
                                    <Icon className="w-5 h-5" aria-hidden="true" />
                                </div>
                                <h3 className="font-bold text-gray-900 mb-2">{step.title}</h3>
                                <p className="text-sm text-gray-600 leading-relaxed">{step.description}</p>
                            </div>
                        );
                    })}
                </div>
            </section>

            <section className="mb-14">
                <h2 className="text-2xl font-bold text-gray-900 mb-2 flex items-center gap-2">
                    <PhoneCall className="w-6 h-6 text-emerald-500" /> {t("hotlinesTitle")}
                </h2>
                <p className="text-sm text-gray-500 mb-6">{t("hotlinesNote")}</p>
                <ul className="space-y-3">
                    {hotlines.map((h) => (
                        <li
                            key={h.name}
                            className="flex flex-wrap items-center justify-between gap-3 p-5 bg-gray-50 rounded-2xl border border-gray-100"
                        >
                            <div className="min-w-0">
                                <p className="font-bold text-gray-900">{h.name}</p>
                                <p className="text-xs text-gray-500 mt-0.5">{h.note}</p>
                            </div>
                            <a
                                href={dialHref(h)}
                                {...(h.whatsapp
                                    ? { target: "_blank", rel: "noopener noreferrer" }
                                    : {})}
                                className="shrink-0 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-black hover:bg-emerald-700 transition-all flex items-center gap-1.5"
                            >
                                {h.whatsapp ? (
                                    <MessageCircle className="w-4 h-4" aria-hidden="true" />
                                ) : (
                                    <PhoneCall className="w-4 h-4" aria-hidden="true" />
                                )}
                                {h.number}
                            </a>
                        </li>
                    ))}
                </ul>
            </section>

            <section className="p-8 bg-indigo-50/50 border border-indigo-100 rounded-3xl text-center">
                <h2 className="text-xl font-bold text-gray-900 mb-3 flex items-center justify-center gap-2">
                    <MessageCircle className="w-5 h-5 text-indigo-500" /> {t("reachOutTitle")}
                </h2>
                <p className="text-gray-600 max-w-2xl mx-auto leading-relaxed">{t("reachOutBody")}</p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                    <Link href="/appointments" className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all">
                        Book a Session
                    </Link>
                    <Link href="/" className="px-6 py-3 bg-white border border-gray-200 text-gray-700 rounded-2xl font-bold hover:bg-gray-50 transition-all">
                        Back to Home
                    </Link>
                </div>
            </section>
        </main>
    );
}
