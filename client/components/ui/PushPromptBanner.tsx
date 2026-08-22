"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import { BellRing, X } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useAuth } from "@/context/AuthContext";

export default function PushPromptBanner() {
    const { user } = useAuth();
    const { supported, subscribed, dismissed, subscribe, dismiss } = usePushNotifications();

    // Attempt subscription automatically once on first login (browser shows the prompt)
    useEffect(() => {
        if (!supported || !user || subscribed) return;
        const timer = setTimeout(() => {
            if (Notification.permission === "default") subscribe();
        }, 4000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [supported, user]);

    if (!user || !supported || subscribed || dismissed) return null;
    if (Notification.permission === "granted") return null;

    return (
        <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="fixed bottom-4 right-4 z-[70] bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 max-w-xs"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                        <BellRing className="w-4.5 h-4.5" />
                    </div>
                    <div>
                        <p className="text-sm font-black text-gray-900">Enable notifications?</p>
                        <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">
                            Get alerts for appointments, messages and reminders — even when MindEase is closed.
                        </p>
                    </div>
                </div>
                <button onClick={dismiss} className="text-gray-300 hover:text-gray-500 transition-colors shrink-0">
                    <X className="w-4 h-4" />
                </button>
            </div>
            <button
                onClick={subscribe}
                className="mt-3 w-full py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-all"
            >
                Allow notifications
            </button>
        </motion.div>
    );
}
