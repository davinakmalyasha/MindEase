"use client";

import { useCallback, useEffect, useState } from "react";
import { Siren, MessageCircle } from "lucide-react";
import Link from "next/link";
import Dialog from "@/components/ui/Dialog";

interface SOSAlert {
    patientName?: string;
    patientId?: number;
}

/** How many alerts to hold before dropping the oldest. */
const MAX_QUEUE = 3;

/**
 * Urgent alert shown to clinicians when a patient presses SOS.
 *
 * Mounted once at the application root rather than inside a dashboard layout:
 * previously it only existed on `/dashboard/*`, so a clinician reading a message
 * — the most likely place to be when an SOS arrives — never saw it.
 *
 * Dismissal is deliberately non-dismissible by backdrop click or Escape. This
 * is an interrupt: a clinician should have to make an explicit choice, and
 * accidentally clicking the backdrop should not hide a disclosure that someone
 * in distress made.
 */
export default function SOSAlertModal() {
    const [alerts, setAlerts] = useState<SOSAlert[]>([]);

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            setAlerts((previous) => [...previous.slice(-(MAX_QUEUE - 1)), detail]);
        };
        window.addEventListener("realtime:sos-alert", handler);
        return () => window.removeEventListener("realtime:sos-alert", handler);
    }, []);

    const dismiss = useCallback(() => {
        setAlerts((previous) => previous.slice(1));
    }, []);

    const current = alerts[0] ?? null;
    const remaining = alerts.length - 1;

    return (
        <Dialog
            open={current !== null}
            onClose={dismiss}
            dismissible={false}
            tone="danger"
            title="SOS Alert"
            description="A patient needs support now"
            className="max-w-md border-4 border-rose-500"
        >
            <p
                className="mb-6 text-sm font-semibold leading-relaxed text-gray-700 dark:text-gray-200"
                role="alert"
            >
                <span className="font-black">{current?.patientName || "A patient"}</span> pressed the SOS
                panic button and needs support. Please check in with them as soon as possible.
            </p>

            {remaining > 0 && (
                <p className="mb-4 text-xs font-medium text-gray-500 dark:text-gray-400">
                    {remaining} more {remaining === 1 ? "alert" : "alerts"} waiting.
                </p>
            )}

            <div className="flex gap-3">
                <Link
                    href="/messages"
                    onClick={dismiss}
                    className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-rose-500 py-3 text-sm font-black text-white transition-colors hover:bg-rose-600"
                >
                    <MessageCircle className="h-4 w-4" aria-hidden="true" /> Open chat
                </Link>
                <button
                    type="button"
                    onClick={dismiss}
                    className="rounded-2xl bg-gray-100 px-5 py-3 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                    Dismiss
                </button>
            </div>
        </Dialog>
    );
}

/** Exported for the icon used by the trigger button. */
export { Siren };
