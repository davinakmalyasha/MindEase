"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Video, Phone, ArrowLeft, Bell, Loader2, AlertCircle } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api, { getErrorMessage } from "@/lib/api";
import VideoRoom from "@/components/video/VideoRoom";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

export default function VideoRoomPage() {
    const t = useTranslations("features.video");
    const params = useParams<{ appointmentId: string }>();
    const router = useRouter();
    const { user } = useAuth();
    const [room, setRoom] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [peerJoined, setPeerJoined] = useState(false);

    useEffect(() => {
        if (!params.appointmentId) return;
        api.post(`/appointments/${params.appointmentId}/join`)
            .then((res) => setRoom(res.data?.data))
            .catch((err) => {
                const msg = getErrorMessage(err, "Failed to open the consultation room");
                const match = msg.match(/The room opens in (\d+) minutes/);
                setError(match ? t("opensIn", { minutes: match[1] }) : msg);
            })
            .finally(() => setIsLoading(false));
    }, [params.appointmentId]);

    useEffect(() => {
        const handler = () => setPeerJoined(true);
        window.addEventListener("realtime:appointment-join", handler);
        return () => window.removeEventListener("realtime:appointment-join", handler);
    }, []);

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    return (
        <DashboardLayout>
            <div className="mb-6 flex items-center justify-between">
                <button
                    onClick={() => router.back()}
                    className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold transition-all text-sm"
                >
                    <ArrowLeft className="w-4 h-4" /> {t("back")}
                </button>
                <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">{t("badge")}</span>
            </div>

            {isLoading ? (
                <div className="bg-white rounded-3xl border border-gray-100 p-10 flex items-center justify-center gap-3 text-gray-400">
                    <Loader2 className="w-5 h-5 animate-spin" /> {t("opening")}
                </div>
            ) : error ? (
                <div className="bg-white rounded-3xl border border-gray-100 p-10 text-center max-w-lg mx-auto">
                    <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                    <h2 className="text-lg font-extrabold text-gray-900 mb-2">{t("notAvailable")}</h2>
                    <p className="text-sm text-gray-500">{error}</p>
                    <p className="text-xs text-gray-400 mt-4">
                        {t("notAvailableHint")}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="bg-white rounded-3xl border border-gray-100 p-5 flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-center gap-4">
                            <div className={cn("w-12 h-12 rounded-2xl text-white flex items-center justify-center shadow-lg", room.consultationType === "voice" ? "bg-indigo-500 shadow-indigo-200" : "bg-rose-500 shadow-rose-200")}>
                                {room.consultationType === "voice" ? <Phone className="w-6 h-6" /> : <Video className="w-6 h-6" />}
                            </div>
                            <div>
                                <p className="font-extrabold text-gray-900">
                                    {user.role === "doctor" ? `${t("sessionWithDoctor")} ${room.patient?.name || t("yourPatient")}` : `${t("sessionWithDoctor")} ${room.doctor?.name || t("yourDoctor")}`}
                                </p>
                                <p className="text-xs text-gray-400 font-semibold">
                                    {new Date(room.openedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {room.startTime}–{room.endTime}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-3 py-2 rounded-xl">
                            <Bell className="w-3.5 h-3.5" /> {peerJoined ? t("peerJoined") : t("peerWillBeNotified")}
                        </div>
                    </div>

                    <VideoRoom
                        grant={{
                            provider: room.provider ?? "jitsi",
                            room: room.room ?? room.meetingLink,
                            token: room.token ?? null,
                            identity: room.identity,
                        }}
                        consultationType={room.consultationType}
                    />

                    <p className="text-[11px] text-gray-400 text-center">
                        {t("poweredBy")} {user.role === "doctor" ? t("yourPatient") : t("yourDoctor")}.
                    </p>
                </div>
            )}
        </DashboardLayout>
    );
}
