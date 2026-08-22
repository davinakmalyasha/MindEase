"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";
import { Siren, X, PhoneCall, HeartPulse } from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import Spinner from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";

interface SOSResult {
    doctorAlerted: boolean;
    doctorName: string | null;
    hotlines: { name: string; contact: string }[];
}

export default function SOSButton() {
    const t = useTranslations("features.sos");
    const { toast } = useToast();
    const confirm = useConfirm();
    const [isOpen, setIsOpen] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [result, setResult] = useState<SOSResult | null>(null);

    const send = async () => {
        const ok = await confirm({
            title: t("title"),
            message: t("confirm"),
            confirmLabel: t("title"),
            danger: true,
        });
        if (!ok) return;
        setIsSending(true);
        try {
            const res = await api.post("/support/sos");
            setResult(res.data?.data);
            toast("SOS sent", "success");
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to send SOS. Please call a hotline directly."), "error");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <>
            <button
                onClick={() => {
                    setResult(null);
                    setIsOpen(true);
                }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-rose-500 text-white font-bold text-sm hover:bg-rose-600 transition-all shadow-lg shadow-rose-200"
            >
                <Siren className="w-4 h-4" /> SOS
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
                        onClick={() => setIsOpen(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl"
                        >
                            <div className="flex items-start justify-between mb-5">
                                <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-2xl bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-200">
                                        <Siren className="w-6 h-6" />
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-black text-gray-900">{t("title")}</h3>
                                        <p className="text-xs text-gray-400">{t("subtitle")}</p>
                                    </div>
                                </div>
                                <button onClick={() => setIsOpen(false)} className="text-gray-300 hover:text-gray-500 transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            {result ? (
                                <div className="space-y-4">
                                    <div className={cn("p-4 rounded-2xl border flex items-start gap-3", result.doctorAlerted ? "bg-emerald-50 border-emerald-100" : "bg-amber-50 border-amber-100")}>
                                        <HeartPulse className={cn("w-5 h-5 shrink-0 mt-0.5", result.doctorAlerted ? "text-emerald-600" : "text-amber-600")} />
                                        <p className="text-sm font-semibold text-gray-700 leading-relaxed">
                                            {result.doctorAlerted
                                                ? `${t("alerted")}${result.doctorName ? ` ${t("myDoctor")}: ${result.doctorName}.` : ""}`
                                                : t("alerted")}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{t("crisisHotlines")}</p>
                                        <div className="space-y-2">
                                            {result.hotlines.map((h) => (
                                                <div key={h.name} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                                                    <span className="text-sm font-bold text-gray-700">{h.name}</span>
                                                    <a
                                                        href={`https://wa.me/${h.contact.replace(/\D/g, "")}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-center gap-1 text-emerald-600 font-bold text-sm hover:underline"
                                                    >
                                                        <PhoneCall className="w-3.5 h-3.5" /> {h.contact}
                                                    </a>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    onClick={send}
                                    disabled={isSending}
                                    className="w-full py-4 bg-rose-500 text-white rounded-2xl font-black text-lg flex items-center justify-center gap-2 hover:bg-rose-600 transition-all shadow-lg shadow-rose-200 disabled:opacity-60"
                                >
                                    {isSending ? <Spinner size="sm" className="text-white" /> : <Siren className="w-5 h-5" />}
                                    {t("title")}
                                </button>
                            )}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
