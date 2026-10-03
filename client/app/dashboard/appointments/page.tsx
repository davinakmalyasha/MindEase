"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
    Calendar,
    Clock,
    User as UserIcon,
    CheckCircle2,
    XCircle,
    Clock3,
    Star,
    Video,
    MessageSquare,
    Phone,
    Sparkles,
    MessageCircle,
    ArrowUpRight,
    CalendarClock,
    CalendarPlus,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import ReviewModal from "@/components/ReviewModal";
import RescheduleModal from "@/components/appointments/RescheduleModal";
import RebookModal from "@/components/appointments/RebookModal";
import FollowUpModal from "@/components/appointments/FollowUpModal";
import StatusBadge from "@/components/ui/StatusBadge";
import Spinner from "@/components/ui/Spinner";
import api, { getErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useMyAppointments, useUpdateAppointmentStatus } from "@/hooks/queries/useAppointmentsQuery";

export default function AppointmentHistory() {
    const router = useRouter();
    const { user } = useAuth();
    const { toast } = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [reviewTarget, setReviewTarget] = useState<any>(null);
    const [rescheduleTarget, setRescheduleTarget] = useState<any>(null);
    const [rebookOptions, setRebookOptions] = useState<any>(null);
    const [rebookTarget, setRebookTarget] = useState<any>(null);
    const [isFetchingRebook, setIsFetchingRebook] = useState(false);
    const [followUpTarget, setFollowUpTarget] = useState<any>(null);

    const { data: appointments = [], isLoading } = useMyAppointments();
    const statusMutation = useUpdateAppointmentStatus();

    const handleStatusUpdate = async (id: number, status: string) => {
        statusMutation.mutate(
            { id, status },
            {
                onSuccess: () => {
                    toast(
                        status === "confirmed" ? "Appointment confirmed"
                            : status === "cancelled" ? "Appointment cancelled"
                            : "Session completed",
                        "success"
                    );
                },
            }
        );
    };

    const handleCancel = async (id: number) => {
        const ok = await confirm({
            title: "Cancel this appointment?",
            message: "The slot will be released and the doctor will be notified.",
            confirmLabel: "Yes, cancel it",
            danger: true,
        });
        if (!ok) return;
        handleStatusUpdate(id, "cancelled");

        // Rebook assist: fetch alternative slots for the patient
        if (user?.role === "patient") {
            setIsFetchingRebook(true);
            try {
                const res = await api.get(`/appointments/${id}/rebook-options`);
                setRebookOptions(res.data?.data);
                setRebookTarget({ id });
            } catch { /* no alternatives available */ }
            finally {
                setIsFetchingRebook(false);
            }
        }
    };

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    return (
        <DashboardLayout>
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
                <div>
                    <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">
                        Consultation <span className="text-indigo-600">History</span>
                    </h1>
                    <p className="text-gray-500 mt-2">
                        {user.role === "doctor" ? "Approve, complete and review your sessions" : "Track your sessions, reflections and reviews"}
                    </p>
                </div>
                {user.role === "patient" && (
                    <button
                        onClick={() => router.push("/appointments")}
                        className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                    >
                        Book New <ArrowUpRight className="w-4 h-4" />
                    </button>
                )}
            </div>

            {isLoading ? (
                <div className="grid grid-cols-1 gap-4">
                    {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="bg-white border border-gray-100 rounded-3xl p-6 animate-pulse">
                            <div className="flex gap-6 items-center">
                                <div className="w-16 h-16 rounded-2xl bg-gray-100" />
                                <div className="space-y-2 flex-1">
                                    <div className="h-3 w-1/4 bg-gray-100 rounded" />
                                    <div className="h-5 w-1/3 bg-gray-100 rounded-lg" />
                                </div>
                                <div className="h-8 w-24 bg-gray-100 rounded-full" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : appointments.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                    {appointments.map((app: any, idx: number) => (
                        <motion.div
                                key={app.id}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: idx * 0.05 }}
                                className="bg-white border border-gray-100 rounded-3xl p-6 hover:shadow-xl hover:shadow-indigo-500/5 transition-all"
                            >
                                <div className="flex flex-col lg:flex-row gap-6 lg:items-center">
                                    <div className="flex items-center gap-4 min-w-[240px]">
                                        <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center overflow-hidden border border-indigo-100">
                                            {user.role === "doctor" ? (
                                                app.user?.avatar ? (
                                                    <img src={app.user.avatar} alt="Patient" className="w-full h-full object-cover" />
                                                ) : (
                                                    <UserIcon className="w-8 h-8 text-indigo-300" />
                                                )
                                            ) : (
                                                app.doctor?.user?.avatar ? (
                                                    <img src={app.doctor.user.avatar} alt="Doctor" className="w-full h-full object-cover" />
                                                ) : (
                                                    <UserIcon className="w-8 h-8 text-indigo-300" />
                                                )
                                            )}
                                        </div>
                                        <div>
                                            <p className="text-sm text-gray-400 font-medium">
                                                {user.role === "doctor" ? "Patient" : "Specialist"}
                                            </p>
                                            <h3 className="text-lg font-bold text-gray-900 truncate">
                                                {user.role === "doctor" ? app.user?.name : app.doctor?.user?.name || "Doctor"}
                                            </h3>
                                            <div className="flex items-center gap-2 mt-1">
                                                {app.consultationType === "video" && <Video className="w-3 h-3 text-indigo-500" />}
                                                {app.consultationType === "voice" && <Phone className="w-3 h-3 text-indigo-500" />}
                                                {app.consultationType === "chat" && <MessageSquare className="w-3 h-3 text-indigo-500" />}
                                                <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">{app.consultationType}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex flex-wrap gap-6 flex-1">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center">
                                                <Calendar className="w-5 h-5 text-gray-400" />
                                            </div>
                                            <div>
                                                <p className="text-xs text-gray-400 font-bold uppercase tracking-tighter">Date</p>
                                                <p className="text-sm font-bold text-gray-700">{new Date(app.appointmentDate).toLocaleDateString('en-GB')}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center">
                                                <Clock className="w-5 h-5 text-gray-400" />
                                            </div>
                                            <div>
                                                <p className="text-xs text-gray-400 font-bold uppercase tracking-tighter">Time</p>
                                                <p className="text-sm font-bold text-gray-700">{app.startTime} - {app.endTime}</p>
                                            </div>
                                        </div>
                                        {app.notes && (
                                            <div className="flex items-center gap-3 max-w-[240px]">
                                                <p className="text-xs text-gray-400 italic truncate">&ldquo;{app.notes}&rdquo;</p>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex items-center justify-between lg:justify-end gap-2 flex-wrap">
                                        <StatusBadge status={app.status} />

                                        {user.role === "doctor" && app.status === "pending" && (
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => handleStatusUpdate(app.id, "confirmed")}
                                                    className="flex items-center gap-1 px-3 py-2 bg-emerald-500 text-white rounded-xl font-bold text-xs hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/20"
                                                >
                                                    <CheckCircle2 className="w-4 h-4" /> Accept
                                                </button>
                                                <button
                                                    onClick={() => handleStatusUpdate(app.id, "cancelled")}
                                                    className="flex items-center gap-1 px-3 py-2 bg-rose-500 text-white rounded-xl font-bold text-xs hover:bg-rose-600 transition-colors shadow-lg shadow-rose-500/20"
                                                >
                                                    <XCircle className="w-4 h-4" /> Reject
                                                </button>
                                            </div>
                                        )}

                                        {user.role === "doctor" && app.status === "confirmed" && (
                                            <button
                                                onClick={() => handleStatusUpdate(app.id, "completed")}
                                                className="flex items-center gap-1 px-3 py-2 bg-blue-500 text-white rounded-xl font-bold text-xs hover:bg-blue-600 transition-colors"
                                            >
                                                <CheckCircle2 className="w-4 h-4" /> Mark Completed
                                            </button>
                                        )}

                                        {app.status === "confirmed" && app.meetingLink && ["video", "voice"].includes(app.consultationType) && (
                                            <button
                                                onClick={() => router.push(`/dashboard/video/${app.id}`)}
                                                className="flex items-center gap-1 px-3 py-2 bg-rose-500 text-white rounded-xl font-bold text-xs hover:bg-rose-600 transition-all shadow-lg shadow-rose-500/20"
                                            >
                                                {app.consultationType === "voice" ? <Phone className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                                                Join {app.consultationType === "voice" ? "Voice Call" : "Video Call"}
                                            </button>
                                        )}

                                        {app.status === "confirmed" && (
                                            <button
                                                onClick={async () => {
                                                    try {
                                                        const res = await api.get(`/appointments/${app.id}/ics`, { responseType: "blob" });
                                                        const url = URL.createObjectURL(new Blob([res.data], { type: "text/calendar" }));
                                                        const a = document.createElement("a");
                                                        a.href = url;
                                                        a.download = `mindease-session-${app.id}.ics`;
                                                        a.click();
                                                        URL.revokeObjectURL(url);
                                                        toast("Calendar file downloaded — open it to add to your calendar", "success");
                                                    } catch (err: any) {
                                                        toast(getErrorMessage(err, "Failed to export calendar file"), "error");
                                                    }
                                                }}
                                                className="flex items-center gap-1 px-3 py-2 bg-white border border-gray-200 text-gray-600 rounded-xl font-bold text-xs hover:bg-gray-50 transition-all"
                                            >
                                                <CalendarPlus className="w-4 h-4" /> Add to Calendar
                                            </button>
                                        )}

                                        {app.status === "confirmed" && (user.role === "doctor" ? app.user?.phone_number : app.doctor?.user?.phone_number) && (
                                            <a
                                                href={`https://wa.me/${(user.role === "doctor" ? app.user?.phone_number : app.doctor?.user?.phone_number)!.replace(/\D/g, '')}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-1 px-3 py-2 bg-emerald-500 text-white rounded-xl font-bold text-xs hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20"
                                            >
                                                <MessageSquare className="w-4 h-4" /> WhatsApp
                                            </a>
                                        )}

                                        {user.role === "patient" && (app.status === "pending" || app.status === "confirmed") && (
                                            <button
                                                onClick={() => setRescheduleTarget(app)}
                                                className="flex items-center gap-1 px-3 py-2 bg-indigo-50 text-indigo-600 rounded-xl font-bold text-xs hover:bg-indigo-100 transition-all"
                                            >
                                                <CalendarClock className="w-4 h-4" /> Reschedule
                                            </button>
                                        )}

                                        {app.status === "confirmed" && (
                                            <button
                                                onClick={() => {
                                                    // The conversation is keyed by the
                                                    // counterpart's *user* id, which is
                                                    // `doctor.user.id` — not `doctor.userId`,
                                                    // which is the doctor's own profile id.
                                                    // This read `app.doctor?.userId`, so the
                                                    // link resolved to `?with=undefined` and the
                                                    // thread never opened. Every other read of
                                                    // the counterpart in this file goes through
                                                    // `app.doctor.user.id`.
                                                    const counterpartId =
                                                        user.role === "doctor"
                                                            ? app.user?.id
                                                            : app.doctor?.user?.id;
                                                    if (counterpartId) {
                                                        router.push(`/messages?with=${counterpartId}`);
                                                    }
                                                }}
                                                disabled={user.role === "doctor" ? !app.user?.id : !app.doctor?.user?.id}
                                                className="flex items-center gap-1 px-3 py-2 bg-indigo-500 text-white rounded-xl font-bold text-xs hover:bg-indigo-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                <MessageCircle className="w-4 h-4" /> Chat
                                            </button>
                                        )}

                                        {user.role === "patient" && app.status === "confirmed" && (
                                            <button
                                                onClick={() => router.push(`/dashboard/pre-session/${app.id}`)}
                                                className="flex items-center gap-1 px-3 py-2 bg-violet-500 text-white rounded-xl font-bold text-xs hover:bg-violet-600 transition-all"
                                            >
                                                <Sparkles className="w-4 h-4" /> Pre-Session
                                            </button>
                                        )}

                                        {user.role === "doctor" && app.status === "confirmed" && (
                                            <button
                                                onClick={() => router.push(`/dashboard/briefing/${app.id}`)}
                                                className="flex items-center gap-1 px-3 py-2 bg-violet-500 text-white rounded-xl font-bold text-xs hover:bg-violet-600 transition-all"
                                            >
                                                <Sparkles className="w-4 h-4" /> AI Briefing
                                            </button>
                                        )}

                                        {user.role === "patient" && app.status === "pending" && (
                                            <button
                                                onClick={() => handleCancel(app.id)}
                                                className="flex items-center gap-1 px-3 py-2 bg-rose-50 text-rose-600 rounded-xl font-bold text-xs hover:bg-rose-100 transition-all"
                                            >
                                                <XCircle className="w-4 h-4" /> Cancel
                                            </button>
                                        )}

                                        {user.role === "patient" && app.status === "cancelled" && (
                                            <button
                                                onClick={async () => {
                                                    setIsFetchingRebook(true);
                                                    try {
                                                        const res = await api.get(`/appointments/${app.id}/rebook-options`);
                                                        setRebookOptions(res.data?.data);
                                                        setRebookTarget({ id: app.id });
                                                    } catch {
                                                        toast("No open slots right now — try the doctor directory", "error");
                                                    } finally {
                                                        setIsFetchingRebook(false);
                                                    }
                                                }}
                                                className="flex items-center gap-1 px-3 py-2 bg-indigo-50 text-indigo-600 rounded-xl font-bold text-xs hover:bg-indigo-100 transition-all"
                                            >
                                                <CalendarClock className="w-4 h-4" /> Find Alternatives
                                            </button>
                                        )}

                                        {user.role === "patient" && app.status === "completed" && (
                                            <button
                                                onClick={() => setReviewTarget(app)}
                                                className="flex items-center gap-1 px-3 py-2 bg-amber-500 text-white rounded-xl font-bold text-xs hover:bg-amber-600 transition-all shadow-lg shadow-amber-500/20"
                                            >
                                                <Star className="w-4 h-4" /> Rate
                                            </button>
                                        )}

                                        {user.role === "doctor" && app.status === "completed" && !app.followUp && (
                                            <button
                                                onClick={() => setFollowUpTarget(app)}
                                                className="flex items-center gap-1 px-3 py-2 bg-violet-50 text-violet-600 rounded-xl font-bold text-xs hover:bg-violet-100 transition-all"
                                            >
                                                <CalendarClock className="w-4 h-4" /> Suggest Follow-up
                                            </button>
                                        )}

                                        {user.role === "patient" && app.followUp?.status === "pending" && (
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={async () => {
                                                        try {
                                                            await api.post(`/follow-ups/${app.followUp.id}/accept`);
                                                            toast("Follow-up accepted — the doctor will confirm it", "success");
                                                            queryClient.invalidateQueries({ queryKey: ["appointments", "mine"] });
                                                        } catch (err: any) {
                                                            toast(getErrorMessage(err, "Failed to accept follow-up"), "error");
                                                        }
                                                    }}
                                                    className="flex items-center gap-1 px-3 py-2 bg-emerald-500 text-white rounded-xl font-bold text-xs hover:bg-emerald-600 transition-all"
                                                >
                                                    <CheckCircle2 className="w-4 h-4" /> Accept Follow-up
                                                </button>
                                                <button
                                                    onClick={async () => {
                                                        try {
                                                            await api.post(`/follow-ups/${app.followUp.id}/decline`);
                                                            toast("Follow-up declined", "success");
                                                            queryClient.invalidateQueries({ queryKey: ["appointments", "mine"] });
                                                        } catch (err: any) {
                                                            toast(getErrorMessage(err, "Failed to decline follow-up"), "error");
                                                        }
                                                    }}
                                                    className="flex items-center gap-1 px-3 py-2 bg-gray-100 text-gray-500 rounded-xl font-bold text-xs hover:bg-gray-200 transition-all"
                                                >
                                                    <XCircle className="w-4 h-4" /> Decline
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                ) : (
                    <div className="bg-white border border-dashed border-gray-200 rounded-[2.5rem] py-20 text-center">
                            <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-6">
                                <Clock3 className="w-10 h-10 text-gray-300" />
                            </div>
                            <h3 className="text-2xl font-bold text-gray-900 mb-2 font-outfit">No Consultations Yet</h3>
                            <p className="text-gray-500 max-w-sm mx-auto">
                                {user.role === "doctor"
                                    ? "When patients book sessions, they will appear here for you to accept."
                                    : "Your upcoming and past consultation history will appear here once you book an appointment."}
                            </p>
                            {user.role === "patient" && (
                                <button
                                    onClick={() => router.push("/appointments")}
                                    className="mt-8 px-8 py-3 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-600/20"
                                >
                                    Book Now
                                </button>
                            )}
                    </div>
                )
            }

            <AnimatePresence>
                {/* `ReviewModal` is always mounted and owns its own presence via
                    `Dialog`, so the exit animation runs. The other modals below
                    still gate on their own state. */}
                <ReviewModal
                    open={reviewTarget !== null}
                    doctorId={reviewTarget?.doctor?.id || reviewTarget?.doctorId || 0}
                    doctorName={reviewTarget?.doctor?.user?.name || "Doctor"}
                    appointmentId={reviewTarget?.id || 0}
                    onClose={() => setReviewTarget(null)}
                    onSuccess={() => queryClient.invalidateQueries({ queryKey: ["appointments", "mine"] })}
                />
                {rescheduleTarget && (
                    <RescheduleModal
                        appointment={rescheduleTarget}
                        onClose={() => setRescheduleTarget(null)}
                    />
                )}
                {rebookTarget && rebookOptions && (
                    <RebookModal
                        options={rebookOptions}
                        isFetching={isFetchingRebook}
                        onClose={() => {
                            setRebookTarget(null);
                            setRebookOptions(null);
                        }}
                    />
                )}
                {followUpTarget && (
                    <FollowUpModal
                        appointmentId={followUpTarget.id}
                        onClose={() => setFollowUpTarget(null)}
                        onDone={() => queryClient.invalidateQueries({ queryKey: ["appointments", "mine"] })}
                    />
                )}
            </AnimatePresence>
        </DashboardLayout>
    );
}
