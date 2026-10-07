"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Video, Phone, ArrowLeft, Bell, Loader2, AlertCircle, ShieldAlert, RotateCcw } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api, { getErrorMessage } from "@/lib/api";
import VideoRoom from "@/components/video/VideoRoom";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

/** The `/join` response. `degraded` is the server's own statement, not a guess. */
interface RoomGrant {
    provider: "livekit" | "jitsi";
    room: string;
    token: string | null;
    identity: string;
    degraded: boolean;
    degradedReason: string | null;
    meetingLink: string | null;
    consultationType: string;
    startTime: string | null;
    endTime: string | null;
    openedAt: number;
    patient?: { name?: string };
    doctor?: { name?: string };
}

export default function VideoRoomPage() {
    const t = useTranslations("features.video");
    const format = useFormatter();
    const params = useParams<{ appointmentId: string }>();
    const router = useRouter();
    const { user } = useAuth();
    const [room, setRoom] = useState<RoomGrant | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [peerJoined, setPeerJoined] = useState(false);

    // Bumping this re-runs the join. The room seed is persisted on the
    // appointment, so a retry lands in the same room as the other participant
    // rather than stranding them.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!params.appointmentId) return;
        const controller = new AbortController();
        // The reset happens in the async body, not synchronously here: setting
        // state directly in an effect body forces a second render pass before
        // the request is even in flight, and React's own guidance is to let the
        // effect start the work and set state from its result.
        const start = async () => {
            setIsLoading(true);
            setError(null);
            try {
                const res = await api.post(
                    `/appointments/${params.appointmentId}/join`,
                    undefined,
                    { signal: controller.signal }
                );
                if (controller.signal.aborted) return;
                setRoom(res.data?.data ?? null);
            } catch (err) {
                if (controller.signal.aborted) return;
                // The fallback has to be translated: a network failure on the
                // Indonesian page used to render an English sentence, because
                // this string was never in the locale files.
                const msg = getErrorMessage(err, t("joinFailed"));
                const match = msg.match(/The room opens in (\d+) minutes/);
                setError(match ? t("opensIn", { minutes: match[1] }) : msg);
            } finally {
                if (!controller.signal.aborted) setIsLoading(false);
            }
        };
        void start();
        return () => controller.abort();
    }, [params.appointmentId, attempt, t]);

    useEffect(() => {
        const handler = () => setPeerJoined(true);
        window.addEventListener("realtime:appointment-join", handler);
        return () => window.removeEventListener("realtime:appointment-join", handler);
    }, []);

    if (!user) {
        return (
            <DashboardLayout>
                <div
                    className="h-40 bg-gray-50 rounded-3xl animate-pulse"
                    role="status"
                    aria-label={t("opening")}
                />
            </DashboardLayout>
        );
    }

    const isDoctor = user.role === "doctor";
    // The server's word, not a value derived from the provider name in the
    // browser. A privacy disclosure whose truth is computed client-side is a
    // disclosure that can be wrong.
    const degraded = room?.degraded === true;

    return (
        <DashboardLayout>
            <div className="mb-6 flex items-center justify-between gap-4">
                <button
                    type="button"
                    onClick={() => router.back()}
                    className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold transition-all text-sm"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" /> {t("back")}
                </button>
                {/* The badge has to reflect the transport. "Secure Consultation
                    Room" next to a jitsi iframe contradicted the disclosure two
                    hundred pixels below it, in the one place a patient is
                    deciding whether to talk. */}
                {room ? (
                    degraded ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-xl">
                            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                            {t("badgeUnverified")}
                        </span>
                    ) : (
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                            {t("badge")}
                        </span>
                    )
                ) : null}
            </div>

            {isLoading ? (
                <div
                    className="bg-white rounded-3xl border border-gray-100 p-10 flex items-center justify-center gap-3 text-gray-400"
                    role="status"
                    aria-live="polite"
                >
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> {t("opening")}
                </div>
            ) : error ? (
                <div className="bg-white rounded-3xl border border-gray-100 p-10 text-center max-w-lg mx-auto">
                    <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" aria-hidden="true" />
                    <h2 className="text-lg font-extrabold text-gray-900 mb-2">{t("notAvailable")}</h2>
                    <p className="text-sm text-gray-500">{error}</p>
                    <p className="text-xs text-gray-400 mt-4">{t("notAvailableHint")}</p>
                    <button
                        type="button"
                        onClick={() => setAttempt((n) => n + 1)}
                        className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-gray-900 px-5 py-3 text-sm font-bold text-white"
                    >
                        <RotateCcw className="w-4 h-4" aria-hidden="true" />
                        {t("tryAgain")}
                    </button>
                </div>
            ) : room ? (
                <div className="space-y-4">
                    <div className="bg-white rounded-3xl border border-gray-100 p-5 flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-center gap-4">
                            <div
                                className={cn(
                                    "w-12 h-12 rounded-2xl text-white flex items-center justify-center shadow-lg",
                                    room.consultationType === "voice"
                                        ? "bg-indigo-500 shadow-indigo-200"
                                        : "bg-rose-500 shadow-rose-200"
                                )}
                            >
                                {room.consultationType === "voice" ? (
                                    <Phone className="w-6 h-6" aria-hidden="true" />
                                ) : (
                                    <Video className="w-6 h-6" aria-hidden="true" />
                                )}
                            </div>
                            <div>
                                <p className="font-extrabold text-gray-900">
                                    {/* The two roles need opposite prepositions in
                                        both languages, and there is no
                                        `sessionWithPatient` key - so a doctor
                                        read "Session with your doctor Sarah". */}
                                    {isDoctor
                                        ? `${t("sessionWithPatient")} ${room.patient?.name || t("yourPatient")}`
                                        : `${t("sessionWithDoctor")} ${room.doctor?.name || t("yourDoctor")}`}
                                </p>
                                <p className="text-xs text-gray-400 font-semibold">
                                    {/* `useFormatter`, not `toLocaleString("en-GB")`.
                                        Four pages in this app each hardcoded a
                                        different locale here, so a user who chose
                                        Indonesian still got a British format. */}
                                    {format.dateTime(new Date(room.openedAt), {
                                        day: "numeric",
                                        month: "short",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}{" "}
                                    · {room.startTime}–{room.endTime}
                                </p>
                            </div>
                        </div>
                        <div
                            // A live region: "the other person has arrived" is the
                            // single most consequential thing that happens on this
                            // screen, and it was changing silently.
                            role="status"
                            aria-live="polite"
                            className={cn(
                                "flex items-center gap-2 text-xs font-bold px-3 py-2 rounded-xl border",
                                peerJoined
                                    ? "text-emerald-700 bg-emerald-50 border-emerald-100"
                                    : "text-gray-500 bg-gray-50 border-gray-200"
                            )}
                        >
                            <Bell className="w-3.5 h-3.5" aria-hidden="true" />
                            {peerJoined ? t("peerJoined") : t("peerWillBeNotified")}
                        </div>
                    </div>

                    <VideoRoom
                        grant={{
                            provider: room.provider ?? "jitsi",
                            room: room.room ?? room.meetingLink ?? "",
                            token: room.token ?? null,
                            identity: room.identity,
                            // Server-reported. The room already uses this to pick
                            // the transport; sharing it keeps one source of truth.
                            degraded,
                        }}
                        consultationType={room.consultationType}
                    />

                    <p className="text-[11px] text-gray-400 text-center">
                        {/* Was unconditional, so a LiveKit session was captioned
                            "Powered by Jitsi Meet". */}
                        {degraded ? t("poweredBy") : t("poweredByLiveKit")}{" "}
                        {isDoctor ? t("yourPatient") : t("yourDoctor")}.
                    </p>
                </div>
            ) : null}
        </DashboardLayout>
    );
}
