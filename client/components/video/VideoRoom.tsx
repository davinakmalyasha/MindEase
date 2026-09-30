"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 */

export type VideoGrant = {
    provider: "livekit" | "jitsi";
    /** LiveKit: the ws URL. Jitsi: the iframe URL. */
    room: string;
    token: string | null;
    identity: string;
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

    const isVoice = consultationType === "voice";
    // Derived, not state: it is a property of the grant, and a copy in state
    // would be a second source of truth that could disagree with it.
    const degraded = grant.provider === "jitsi";

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
                    if (track.kind === Tracks.Kind.Video && videoRef.current) {
                        track.attach(videoRef.current);
                    }
                });
                room.on(Events.TrackUnsubscribed, (track: Track) => {
                    if (track.kind === Tracks.Kind.Video) track.detach();
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
                    err instanceof Error ? err.message : "Could not connect to the consultation room."
                );
                setState("failed");
            }
        };

        void connect();

        return () => {
            cancelled = true;
            teardown();
        };
    }, [degraded, grant.room, grant.token, isVoice, onPeerLeft, teardown]);

    const toggleMic = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !muted;
        await room.localParticipant.setMicrophoneEnabled(!next);
        setMuted(next);
    }, [muted]);

    const toggleCamera = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !cameraOff;
        await room.localParticipant.setCameraEnabled(!next);
        setCameraOff(next);
    }, [cameraOff]);

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
                        title="Consultation room"
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
                <p className="text-sm text-gray-600">
                    {error ?? "Could not connect to the consultation room."}
                </p>
            </div>
        );
    }

    if (state !== "connected") {
        return (
            <div className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
                Connecting to the consultation room
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
                    {muted ? "Unmute" : "Mute"}
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
                        {cameraOff ? "Start camera" : "Stop camera"}
                    </button>
                )}
                <button
                    type="button"
                    onClick={teardown}
                    className="inline-flex items-center gap-2 rounded-2xl bg-rose-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-rose-700"
                >
                    <PhoneOff className="h-4 w-4" />
                    Leave
                </button>
            </div>
        </div>
    );
}

function DegradedNotice() {
    return (
        <div
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{DEGRADED_NOTICE}</span>
        </div>
    );
}

/**
 * Shown on the degraded path.
 *
 * Not translated here on purpose: it is a compliance disclosure, and a
 * disclosure that silently changes language between locales is one that can be
 * missed by the person who most needs to read it. It is added to both locale
 * files byte-identical, for the same reason hotline numbers are.
 */
const DEGRADED_NOTICE =
    "This session is not end-to-end authenticated. The room link is a shared URL rather than a per-participant credential, so anyone with the link could join. Configure LiveKit to fix this.";
