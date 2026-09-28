"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Siren, PhoneCall, MessageCircle, HeartPulse, WifiOff } from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import Spinner from "@/components/ui/Spinner";
import Dialog from "@/components/ui/Dialog";
import { cn } from "@/lib/utils";

interface Hotline {
    name: string;
    dial: string;
    contact: string;
    whatsapp: boolean;
}

interface SOSResult {
    doctorAlerted: boolean;
    doctorName: string | null;
    hotlines: Hotline[];
}

/**
 * Crisis numbers shown the instant the panel opens, before and independently of
 * any network call.
 *
 * The previous implementation only rendered hotlines from the server response,
 * which meant the fastest route to a phone number was gated behind a round trip
 * — and on a failed or throttled request, no number was shown at all. Someone in
 * acute distress must never be waiting on our infrastructure to see a
 * emergency number.
 */
const FALLBACK_HOTLINES: Hotline[] = [
    { name: "Emergency (Indonesia)", dial: "112", contact: "112 / 119", whatsapp: false },
    { name: "Kemenkes SEJIWA", dial: "119", contact: "119 ext 8", whatsapp: false },
    { name: "Halo Kemenkes", dial: "1500567", contact: "1500-567", whatsapp: false },
    { name: "Into The Light (WhatsApp)", dial: "628121232012", contact: "+62 812-123-2012", whatsapp: true },
];

export default function SOSButton() {
    const t = useTranslations("features.sos");
    const { toast } = useToast();
    const [isOpen, setIsOpen] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [result, setResult] = useState<SOSResult | null>(null);
    const [failed, setFailed] = useState(false);

    const open = () => {
        setResult(null);
        setFailed(false);
        setIsOpen(true);
    };

    const send = async () => {
        setIsSending(true);
        setFailed(false);
        try {
            const res = await api.post("/support/sos");
            const data = res.data?.data as SOSResult | undefined;
            setResult({
                doctorAlerted: Boolean(data?.doctorAlerted),
                doctorName: data?.doctorName ?? null,
                hotlines: data?.hotlines?.length ? data.hotlines : FALLBACK_HOTLINES,
            });
        } catch (err: any) {
            // A 429 still carries hotlines in `data`, so read them from there
            // rather than discarding an otherwise useful response.
            const payload = err?.response?.data?.data as Partial<SOSResult> | undefined;
            setFailed(true);
            setResult({
                doctorAlerted: false,
                doctorName: null,
                hotlines: payload?.hotlines?.length ? payload.hotlines : FALLBACK_HOTLINES,
            });
            toast(getErrorMessage(err, t("sendFailed")), "error");
        } finally {
            setIsSending(false);
        }
    };

    const hotlines = result?.hotlines ?? FALLBACK_HOTLINES;

    return (
        <>
            <button
                type="button"
                onClick={open}
                aria-haspopup="dialog"
                className="flex items-center gap-2 rounded-2xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-200 transition-all hover:bg-rose-600"
            >
                <Siren className="h-4 w-4" aria-hidden="true" /> SOS
            </button>

            <Dialog
                open={isOpen}
                onClose={() => setIsOpen(false)}
                title={t("title")}
                description={t("subtitle")}
                tone="danger"
            >
                <div className="space-y-5">
                    {result ? (
                        <div
                            className={cn(
                                "flex items-start gap-3 rounded-2xl border p-4",
                                result.doctorAlerted
                                    ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40"
                                    : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                            )}
                            role="status"
                        >
                            <HeartPulse
                                aria-hidden="true"
                                className={cn(
                                    "mt-0.5 h-5 w-5 shrink-0",
                                    result.doctorAlerted
                                        ? "text-emerald-600"
                                        : "text-amber-700 dark:text-amber-400"
                                )}
                            />
                            {/* Never claim a clinician was notified when none was.
                                Telling a distressed user their doctor was alerted
                                is a false safety assurance. */}
                            <p className="text-sm font-semibold leading-relaxed text-gray-800 dark:text-gray-100">
                                {result.doctorAlerted
                                    ? `${t("alerted")}${result.doctorName ? ` ${t("myDoctor")}: ${result.doctorName}.` : ""}`
                                    : t("notAlerted")}
                            </p>
                        </div>
                    ) : null}

                    {failed && (
                        <p
                            className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                            role="alert"
                        >
                            <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            {t("offlineFallback")}
                        </p>
                    )}

                    <div>
                        <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                            {t("crisisHotlines")}
                        </p>
                        <ul className="space-y-2">
                            {hotlines.map((h) => (
                                <li
                                    key={h.name}
                                    className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 p-3 dark:bg-gray-800/60"
                                >
                                    <span className="min-w-0 text-sm font-bold text-gray-700 dark:text-gray-200">
                                        {h.name}
                                    </span>
                                    {/* Voice lines must be `tel:`. Building a
                                        WhatsApp link from "112 / 119" produced
                                        `wa.me/112119`, which is not a number. */}
                                    <a
                                        href={h.whatsapp ? `https://wa.me/${h.dial}` : `tel:${h.dial}`}
                                        {...(h.whatsapp
                                            ? { target: "_blank", rel: "noopener noreferrer" }
                                            : {})}
                                        className="flex shrink-0 items-center gap-1 text-sm font-bold text-emerald-700 hover:underline dark:text-emerald-400"
                                    >
                                        {h.whatsapp ? (
                                            <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                        ) : (
                                            <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
                                        )}
                                        {h.contact}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <a
                        href="/crisis"
                        className="block text-center text-sm font-bold text-indigo-700 hover:underline dark:text-indigo-400"
                    >
                        {t("viewAllResources")}
                    </a>

                    {!result && (
                        <button
                            type="button"
                            onClick={send}
                            disabled={isSending}
                            data-autofocus
                            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-rose-500 py-4 text-lg font-black text-white shadow-lg shadow-rose-200 transition-all hover:bg-rose-600 disabled:opacity-60"
                        >
                            {isSending ? (
                                <Spinner size="sm" className="text-white" />
                            ) : (
                                <Siren className="h-5 w-5" aria-hidden="true" />
                            )}
                            {isSending ? t("sending") : t("alertDoctor")}
                        </button>
                    )}
                </div>
            </Dialog>
        </>
    );
}
