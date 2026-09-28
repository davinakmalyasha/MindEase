"use client";

import { useId, useMemo, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

/** `"14:00"` → `840` minutes, or `null` when the value is not a valid time. */
const toMinutes = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
};

const FIELD_CLASS =
    "w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-50";

export default function FollowUpModal({
    appointmentId,
    onClose,
    onDone,
}: {
    appointmentId: number;
    onClose: () => void;
    onDone: () => void;
}) {
    const { toast } = useToast();
    const [date, setDate] = useState("");
    const [startTime, setStartTime] = useState("09:00");
    const [endTime, setEndTime] = useState("10:00");
    const [notes, setNotes] = useState("");
    const [saving, setSaving] = useState(false);

    // Every field needs a stable id so the <label> is programmatically tied to
    // its control. The previous version had visible labels with no `htmlFor`,
    // so assistive tech announced four unlabelled edit fields in a row.
    const ids = {
        date: useId(),
        start: useId(),
        end: useId(),
        notes: useId(),
        timeError: useId(),
    };

    const startMinutes = toMinutes(startTime);
    const endMinutes = toMinutes(endTime);

    const timeError = useMemo(() => {
        if (startMinutes === null || endMinutes === null) return "Enter a valid time.";
        if (endMinutes <= startMinutes) return "The end time must be after the start time.";
        return null;
    }, [startMinutes, endMinutes]);

    const isValid = Boolean(date) && startMinutes !== null && endMinutes !== null && !timeError;

    const submit = async () => {
        if (!date || !isValid) return;
        setSaving(true);
        try {
            await api.post(`/appointments/${appointmentId}/follow-up`, {
                suggestedDate: date,
                startTime,
                endTime,
                consultationType: "video",
                notes: notes.trim() || undefined,
            });
            toast("Follow-up suggested — the patient has been notified", "success");
            onDone();
            onClose();
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to suggest follow-up"), "error");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open
            onClose={onClose}
            title={
                <span className="flex items-center gap-2">
                    <CalendarClock className="h-5 w-5 text-indigo-500" aria-hidden="true" />
                    Suggest a follow-up
                </span>
            }
            description="Propose the next session — the patient can accept or decline."
        >
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                }}
            >
                <div>
                    <label
                        htmlFor={ids.date}
                        className="mb-1.5 ml-1 block text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400"
                    >
                        Date
                    </label>
                    <input
                        id={ids.date}
                        type="date"
                        required
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        min={new Date().toISOString().slice(0, 10)}
                        className={FIELD_CLASS}
                    />
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label
                            htmlFor={ids.start}
                            className="mb-1.5 ml-1 block text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400"
                        >
                            Start
                        </label>
                        <input
                            id={ids.start}
                            type="time"
                            required
                            step={300}
                            value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                            aria-invalid={timeError ? true : undefined}
                            aria-describedby={timeError ? ids.timeError : undefined}
                            className={FIELD_CLASS}
                        />
                    </div>
                    <div>
                        <label
                            htmlFor={ids.end}
                            className="mb-1.5 ml-1 block text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400"
                        >
                            End
                        </label>
                        <input
                            id={ids.end}
                            type="time"
                            required
                            step={300}
                            value={endTime}
                            onChange={(e) => setEndTime(e.target.value)}
                            aria-invalid={timeError ? true : undefined}
                            aria-describedby={timeError ? ids.timeError : undefined}
                            className={FIELD_CLASS}
                        />
                    </div>
                </div>

                {timeError && (
                    <p
                        id={ids.timeError}
                        role="alert"
                        className="text-sm font-medium text-rose-600 dark:text-rose-400"
                    >
                        {timeError}
                    </p>
                )}

                <div>
                    <label
                        htmlFor={ids.notes}
                        className="mb-1.5 ml-1 block text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400"
                    >
                        Notes (optional)
                    </label>
                    <input
                        id={ids.notes}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Focus areas for the next session…"
                        maxLength={1000}
                        className={FIELD_CLASS}
                    />
                </div>

                <button
                    type="submit"
                    disabled={!isValid || saving}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 py-3.5 font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                        <CalendarClock className="h-4 w-4" aria-hidden="true" />
                    )}
                    Send follow-up suggestion
                </button>
            </form>
        </Dialog>
    );
}
