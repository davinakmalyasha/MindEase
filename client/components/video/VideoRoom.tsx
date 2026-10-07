"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2, MicOff, VideoOff, PhoneOff } from "lucide-react";
import type { Room, RoomEvent, Track } from "livekit-client";

/**
 * The consultation room.
 *
 * Two paths, because the server can be configured for either:
 *
 *  - **livekit**: connects with a short-lived, room-scoped token. The token is
 *    fetched from our own API, so the browser never holds a LiveKit key and
 *    there is no joinable URL - a link is not sufficient to get in.
 *
 *  - **jitsi**: the previous behaviour, a bare iframe. Kept because the server
 *    falls back to it when LiveKit is unconfigured, and a consultation that is
 *    minutes from starting must not fail closed. `degraded` is surfaced on
 *    screen, because a session that is not authenticated is something both
 *    parties should be able to see.
 *
 * `livekit-client` is imported dynamically, so a participant on the jitsi path
 * does not download a WebRTC SDK they will not use, and a chunk-load failure
 * degrades rather than taking the page down.
 *
 * Every string here goes through `useTranslations`. The whole call screen used
 * to be hardcoded English - mute, camera, leave, the connecting state and the
 * compliance disclosure - so an Indonesian patient opened a translated page and
 * then an entirely English consultation.
 */

export type VideoGrant = {
    provider: "livekit" | "jitsi";
    /** LiveKit: the ws URL. Jitsi: the iframe URL. */
    room: string;
    token: string | null;
    identity: string;
    /**
     * The server's own statement of whether this session is authenticated.
     *
     * Optional so the type still describes a grant from an older API. When
     * absent, the component falls back to deriving it from the provider name -
     * which is what it always did, and which is why a `VIDEO_PROVIDER` typo
     * could serve an unauthenticated room while reporting itself as fine.
     */
    degraded?: boolean;
};

type ConnectionState = "idle" | "connecting" | "connected" | "failed";

export default function VideoRoom({
    grant,
    consultationType,
    onPeerLeft,
}: {
    grant: VideoGrant;
    consultationType: string;
    onPeerLeft?: () => void;
}) {
    const t = useTranslations("features.video");
    const [state, setState] = useState<ConnectionState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [muted, setMuted] = useState(consultationType === "voice");
    const [cameraOff, setCameraOff] = useState(consultationType === "voice");

    const roomRef = useRef<Room | null>(null);
    // A `HTMLVideoElement`, not a container. `Track.attach` takes a media
    // element and the SDK writes the stream into it; handing it a div is the
    // kind of thing that type-checks against a loose signature and then
    // renders nothing.
    const videoRef = useRef<HTMLVideoElement | null>(null);
    // Remote video tracks seen so far, and the element they are currently
    // attached to. Held so a publication that lands before the element mounts
    // can be attached once it does - see the effect near `toggleCamera`.
    const remoteVideoRef = useRef<Track[]>([]);
    const videoElRef = useRef<HTMLVideoElement | null>(null);

    const isVoice = consultationType === "voice";
    // The server's word when it gives one, and only otherwise derived from the
    // provider name. Keeping the fallback means an older API still works, but
    // the API is the authority: `AppointmentService.joinRoom` computes
    // `degraded` from whether an operator asked for livekit and the deployment
    // could not supply it, which is a fact the provider name alone does not
    // carry.
    const degraded = grant.degraded ?? grant.provider === "jitsi";

    const teardown = useCallback(() => {
        const room = roomRef.current;
        roomRef.current = null;
        if (room) {
            // Disconnect rather than only leaving locally, so a participant who
            // closes the tab does not leave a ghost in the room.
            room.disconnect().catch(() => undefined);
        }
    }, []);

    useEffect(() => {
        // Captured before the closure: `grant.token` is `string | null`, and a
        // narrowing does not survive into an async callback, so the guard above
        // is not visible to the type checker inside `connect`.
        const token = grant.token;
        const url = grant.room;
        if (degraded || !token) return;

        let cancelled = false;

        const connect = async () => {
            setState("connecting");
            try {
                const { Room: LkRoom, RoomEvent: Events, Track: Tracks } = await import("livekit-client");
                if (cancelled) return;

                const room = new LkRoom();
                roomRef.current = room;

                // Muted before connecting, not after: joining with the microphone
                // already open means the other party hears a join tone before
                // anyone has spoken.
                await room.localParticipant.setMicrophoneEnabled(!isVoice);
                await room.localParticipant.setCameraEnabled(!isVoice);

                room.on(Events.TrackSubscribed, (track: Track) => {
                    if (track.kind === Tracks.Kind.Video) {
                        // A single <video> in the tree, so only one remote
                        // stream at a time here.
                        remoteVideoRef.current = [track];
                        if (videoRef.current) {
                            track.attach(videoRef.current);
                            videoElRef.current = videoRef.current;
                        }
                    } else if (track.kind === Tracks.Kind.Audio) {
                        // No argument. LiveKit creates a detached <audio>,
                        // assigns the MediaStream and calls play(), which
                        // works because a media element with a srcObject plays
                        // audio whether or not it is in the document. Passing
                        // the <video> element here would put an audio stream on
                        // a video sink and the peer would stay silent - which
                        // is exactly what happened: the SDK does not auto-attach
                        // anything, and this handler only ever matched video.
                        track.attach();
                    }
                });
                room.on(Events.TrackUnsubscribed, (track: Track) => {
                    if (track.kind === Tracks.Kind.Video) {
                        remoteVideoRef.current = [];
                        videoElRef.current = null;
                        track.detach();
                    } else if (track.kind === Tracks.Kind.Audio) {
                        track.detach();
                    }
                });
                // The realtime channel already announces arrivals; nothing else
                // covers departures.
                room.on(Events.ParticipantDisconnected, () => onPeerLeft?.());

                // `url` and `token` are connect arguments, not constructor
                // options, in this version of the SDK.
                await room.connect(url, token);

                if (cancelled) {
                    room.disconnect().catch(() => undefined);
                    return;
                }
                setState("connected");
            } catch (err) {
                if (cancelled) return;
                setError(
                    err instanceof Error ? err.message : t("joinFailed")
                );
                setState("failed");
            }
        };

        void connect();

        return () => {
            cancelled = true;
            teardown();
        };
    // `t` is in the dependency list because it is called inside the effect, at line
    // the `joinFailed` fallback. next-intl memoises the translator on the
    // messages and the locale, so listing it does not tear the call down and
    // rebuild it on every render - and omitting it meant the linter had no way
    // to see that the effect closes over a value that can change.
    }, [degraded, grant.room, grant.token, isVoice, onPeerLeft, teardown, t]);

    const toggleMic = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !muted;
        // `setMicrophoneEnabled` throws if the browser denies the permission,
        // and an unhandled rejection here would leave the button showing the
        // opposite of the truth with no way to tell which is wrong.
        try {
            await room.localParticipant.setMicrophoneEnabled(!next);
            setMuted(next);
        } catch {
            setMuted(muted);
        }
    }, [muted]);

    const toggleCamera = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !cameraOff;
        try {
            await room.localParticipant.setCameraEnabled(!next);
            setCameraOff(next);
        } catch {
            setCameraOff(cameraOff);
        }
    }, [cameraOff]);

    /**
     * Attach any remote video that arrived before the <video> element existed.
     *
     * The subscription handler is registered before `room.connect()`, which is
     * correct - missing the peer's first publication is worse - but the element
     * only mounts once `state === "connected"`, and `setState` is awaited
     * afterwards. A peer already in the room therefore publishes a track in that
     * window, `videoRef.current` is null, and the track is silently dropped for
     * the rest of the session. Holding the tracks and attaching once the
     * element is mounted closes the window in both directions.
     */
    useEffect(() => {
        if (state !== "connected") return;
        const element = videoRef.current;
        if (!element) return;
        for (const track of remoteVideoRef.current) {
            if (videoElRef.current !== element) {
                track.attach(element);
                videoElRef.current = element;
            }
        }
    }, [state]);

    // --- Degraded path: the jitsi iframe ------------------------------------
    //
    // Early return, so nothing below may call a hook. Every hook above runs
    // unconditionally for both providers.
    if (degraded) {
        return (
            <div className="space-y-3">
                <DegradedNotice />
                <div className="aspect-video overflow-hidden rounded-3xl bg-black">
                    <iframe
                        title={t("roomTitle")}
                        src={`${grant.room}${isVoice ? "#config.startWithVideoMuted=true&config.prejoinPageEnabled=false" : "#config.prejoinPageEnabled=true"}`}
                        // `allowFullScreen` is a separate attribute from the
                        // `allow` token list; without it the fullscreen control
                        // does nothing in Safari and Firefox.
                        allow="camera; microphone; fullscreen; display-capture; autoplay"
                        allowFullScreen
                        className="h-full w-full border-0"
                    />
                </div>
            </div>
        );
    }

    if (state === "failed") {
        return (
            <div className="rounded-3xl border border-gray-100 bg-white p-10 text-center">
                <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-amber-500" />
                <p className="text-sm text-gray-600" role="alert">
                    {error ?? t("joinFailed")}
                </p>
            </div>
        );
    }

    if (state !== "connected") {
        return (
            <div
                className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-400"
                role="status"
                aria-live="polite"
            >
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                {t("connecting")}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="relative aspect-video overflow-hidden rounded-3xl bg-slate-900">
                <video ref={videoRef} autoPlay playsInline className="h-full w-full" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                    type="button"
                    onClick={toggleMic}
                    className={`inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold transition ${
                        muted ? "bg-rose-50 text-rose-700" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                    aria-pressed={muted}
                >
                    <MicOff className="h-4 w-4" />
                    {muted ? t("unmute") : t("mute")}
                </button>
                {!isVoice && (
                    <button
                        type="button"
                        onClick={toggleCamera}
                        className={`inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold transition ${
                            cameraOff
                                ? "bg-rose-50 text-rose-700"
                                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                        }`}
                        aria-pressed={cameraOff}
                    >
                        <VideoOff className="h-4 w-4" />
                        {cameraOff ? t("startCamera") : t("stopCamera")}
                    </button>
                )}
                <button
                    type="button"
                    onClick={teardown}
                    className="inline-flex items-center gap-2 rounded-2xl bg-rose-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-rose-700"
                >
                    <PhoneOff className="h-4 w-4" />{t("leave")}</button>
            </div>
        </div>
    );
}

function DegradedNotice() {
    const t = useTranslations("features.video");
    return (
        <div
            // `role="status"`, not `role="alert"`: the notice renders on mount,
            // before there is anything else for a user to have started, so
            // interrupting would be wrong. The information is on screen before
            // either party can speak.
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{t("degradedNotice")}</span>
        </div>
    );
}
