"use client";

import { useRouter } from "next/navigation";
import { CalendarClock, Star } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import Spinner from "@/components/ui/Spinner";
import { formatDate, formatIDR, formatTimeRange } from "@/lib/format";

interface RebookOptions {
    sameDoctor: { doctorId: number; slots: any[] };
    similarDoctors: { slot: any; doctor: any }[];
}

export default function RebookModal({
    options,
    isFetching,
    onClose,
}: {
    options: RebookOptions;
    isFetching: boolean;
    onClose: () => void;
}) {
    const router = useRouter();
    const hasAny = options.sameDoctor.slots.length > 0 || options.similarDoctors.length > 0;

    const goToDoctor = (doctorId: number) => {
        onClose();
        router.push(`/doctors/${doctorId}`);
    };

    return (
        <Dialog
            open
            onClose={onClose}
            title={
                <span className="flex items-center gap-2">
                    <CalendarClock className="h-5 w-5 text-indigo-500" aria-hidden="true" />
                    Rebook instantly
                </span>
            }
            description="Your appointment was cancelled. Here are open slots you can book right away."
        >
            {isFetching ? (
                <div className="flex justify-center py-10">
                    <Spinner />
                </div>
            ) : !hasAny ? (
                <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                    No open slots in the next 14 days. Try browsing all specialists.
                </p>
            ) : (
                <div className="max-h-[55vh] space-y-6 overflow-y-auto custom-scrollbar">
                    {options.sameDoctor.slots.length > 0 && (
                        <section>
                            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
                                Same doctor
                            </h3>
                            <div className="space-y-2">
                                {options.sameDoctor.slots.map((slot) => (
                                    <button
                                        key={slot.id}
                                        type="button"
                                        onClick={() => goToDoctor(options.sameDoctor.doctorId)}
                                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3.5 text-left transition-colors hover:bg-indigo-50"
                                    >
                                        <span className="text-sm font-bold text-gray-800 dark:text-gray-100">
                                            {formatDate(slot.date, "en")}
                                        </span>
                                        <span className="text-sm font-black text-indigo-600">
                                            {formatTimeRange(slot.startTime, slot.endTime)}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    {options.similarDoctors.length > 0 && (
                        <section>
                            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
                                Similar specialists
                            </h3>
                            <div className="space-y-2">
                                {options.similarDoctors.map((item, i) => (
                                    <button
                                        key={item.doctor.id ?? i}
                                        type="button"
                                        onClick={() => goToDoctor(item.doctor.id)}
                                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-3.5 text-left transition-colors hover:bg-gray-100/70 dark:border-gray-700 dark:bg-gray-800"
                                    >
                                        <div className="min-w-0 text-left">
                                            <p className="truncate text-sm font-bold text-gray-800 dark:text-gray-100">
                                                {item.doctor.name}
                                            </p>
                                            <p className="truncate text-[11px] font-medium text-gray-500 dark:text-gray-400">
                                                {item.doctor.specialty} · {formatIDR(item.doctor.price)}
                                            </p>
                                        </div>
                                        <div className="shrink-0 text-right">
                                            <p className="text-xs font-black text-indigo-600">
                                                {formatTimeRange(item.slot.startTime, item.slot.endTime)}
                                            </p>
                                            <p className="flex items-center justify-end gap-1 text-[11px] font-medium text-gray-400">
                                                <Star
                                                    className="h-3 w-3 fill-amber-400 text-amber-400"
                                                    aria-hidden="true"
                                                />{" "}
                                                {item.doctor.rating}
                                            </p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            )}
        </Dialog>
    );
}
