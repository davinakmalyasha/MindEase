"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { CalendarClock, Star, X } from "lucide-react";
import Spinner from "@/components/ui/Spinner";

interface RebookOptions {
    sameDoctor: { doctorId: number; slots: any[] };
    similarDoctors: { slot: any; doctor: any }[];
}

export default function RebookModal({ options, isFetching, onClose }: { options: RebookOptions; isFetching: boolean; onClose: () => void }) {
    const router = useRouter();
    const fmt = (d: string) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    const hasAny = options.sameDoctor.slots.length > 0 || options.similarDoctors.length > 0;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={onClose}
        >
            <motion.div
                initial={{ scale: 0.92, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.92, opacity: 0 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-3xl p-7 max-w-lg w-full shadow-2xl max-h-[80vh] overflow-y-auto custom-scrollbar"
            >
                <div className="flex items-start justify-between mb-5">
                    <div>
                        <h3 className="text-lg font-black text-gray-900 flex items-center gap-2">
                            <CalendarClock className="w-5 h-5 text-indigo-500" /> Rebook instantly
                        </h3>
                        <p className="text-xs text-gray-400 mt-1">
                            Your appointment was cancelled. Here are open slots you can book right away.
                        </p>
                    </div>
                    <button onClick={onClose} className="text-gray-300 hover:text-gray-500 transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {isFetching ? (
                    <div className="py-10 flex justify-center"><Spinner /></div>
                ) : !hasAny ? (
                    <p className="py-8 text-center text-sm text-gray-400">
                        No open slots in the next 14 days. Try browsing all specialists.
                    </p>
                ) : (
                    <div className="space-y-6">
                        {options.sameDoctor.slots.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Same doctor</p>
                                <div className="space-y-2">
                                    {options.sameDoctor.slots.map((slot) => (
                                        <button
                                            key={slot.id}
                                            onClick={() => router.push(`/doctors/${options.sameDoctor.doctorId}`)}
                                            className="w-full flex items-center justify-between p-3.5 bg-indigo-50/60 border border-indigo-100 rounded-2xl hover:bg-indigo-50 transition-colors"
                                        >
                                            <span className="text-sm font-bold text-gray-800">{fmt(slot.date)}</span>
                                            <span className="text-sm font-black text-indigo-600">{slot.startTime}–{slot.endTime}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {options.similarDoctors.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Similar specialists</p>
                                <div className="space-y-2">
                                    {options.similarDoctors.map((item, i) => (
                                        <button
                                            key={i}
                                            onClick={() => router.push(`/doctors/${item.doctor.id}`)}
                                            className="w-full flex items-center justify-between p-3.5 bg-gray-50 border border-gray-100 rounded-2xl hover:bg-gray-100/70 transition-colors"
                                        >
                                            <div className="text-left">
                                                <p className="text-sm font-bold text-gray-800">{item.doctor.name}</p>
                                                <p className="text-[11px] text-gray-400 font-medium">
                                                    {item.doctor.specialty} · Rp {item.doctor.price?.toLocaleString("id-ID")}
                                                </p>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-xs font-black text-indigo-600">{item.slot.startTime}–{item.slot.endTime}</p>
                                                <p className="text-[11px] text-gray-400 font-medium flex items-center justify-end gap-1">
                                                    <Star className="w-3 h-3 text-amber-400 fill-amber-400" /> {item.doctor.rating}
                                                </p>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
}
