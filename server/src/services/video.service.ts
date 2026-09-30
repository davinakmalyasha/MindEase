/**
 * Video session credentials.
 *
 * ## Why this exists
 *
 * Sessions previously used a bare iframe embed of the public `meet.jit.si`
 * deployment. That has two problems, both of which matter more than they sound:
 *
 *  1. **Every consultation transited a third party's public infrastructure.**
 *     Therapy sessions are among the most sensitive conversations a person can
 *     have, and they were being relayed through a service whose data handling
 *     is not ours and is not disclosed anywhere in this product.
 *
 *  2. **There was no authentication at all.** The room URL carried a 64-bit
 *     random suffix and nothing else. Anyone who learned or guessed the URL
 *     could join. It was stored in plaintext, included in `.ics` exports, in the
 *     GDPR data export, and in the API response.
 *
 * ## Why the token is minted here and not with the vendor SDK
 *
 * A LiveKit access token is an HS256 JWT signed with the API secret, carrying a
 * `video` claim. That is the whole format, and `jsonwebtoken` is already a
 * dependency for this service's own cookies. Minting it directly is about
 * twenty lines and means:
 *
 *  - no new third-party code in a platform holding mental-health data, which is
 *    the same reasoning `scripts/check-dependencies.js` documents for every
 *    other package here;
 *  - the token's lifetime and scope are visible in this file rather than
 *    delegated to a default in someone else's SDK; and
 *  - the whole thing is unit-testable with no LiveKit account and no Docker,
 *    which is the only way to test it in this repository at all.
 *
 * ## The invariants
 *
 *  - **Room-scoped.** The token grants exactly one room, named from the
 *    appointment. A token cannot be reused against another consultation.
 *  - **Short-lived.** TTL is bounded by the end of the appointment window, not
 *    by a constant. A token issued for a session that ends in ten minutes
 *    expires in ten minutes, so a captured token is not a durable key.
 *  - **Participant-only.** `mint` is only ever reached through `joinRoom`,
 *    which checks that the caller is the appointment's patient or its
 *    clinician before asking for a token.
 *  - **The API secret never leaves the server.** It is used to sign and is not
 *    in any response.
 */
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export type VideoProviderName = "livekit" | "jitsi";

/** What the client needs to open a room, whichever provider is in use. */
export interface VideoGrant {
    provider: VideoProviderName;
    /** LiveKit: the room to connect to. Jitsi: the full iframe URL. */
    room: string;
    /**
     * LiveKit only. A short-lived, room-scoped access token. Never present for
     * jitsi, which has no token concept - which is part of the problem.
     */
    token?: string;
    /** The identity the client should present. Advisory, not a credential. */
    identity: string;
    displayName: string;
}

export interface MintInput {
    appointmentId: number;
    /** The user id of the participant. */
    userId: number;
    displayName: string;
    /** The room name derived from the appointment. */
    roomName: string;
    /** Absolute end of the window the token may be used in. */
    validUntilMs: number;
}

/** What `buildGrant` takes: the seed, and lets the room name be derived. */
export type GrantInput = Omit<MintInput, "roomName"> & { roomSeed: string };

/**
 * Room name.
 *
 * Derived from the appointment id plus a per-appointment random component, so
 * two deployments sharing a LiveKit project - a staging and a production one -
 * cannot have a room name collide, and so a room name is not guessable from the
 * appointment id alone.
 *
 * The random component is generated once and reused for the life of the
 * appointment, so both participants joining independently land in the same room.
 */
const roomNameFor = (appointmentId: number, seed: string) => `mindease-${appointmentId}-${seed}`;

/** Exported for tests. Derives the room name from a fixed seed. */
export const roomNameForTest = roomNameFor;

/**
 * `VIDEO_TOKEN_MAX_TTL_SECONDS` caps how long a token can outlive the window.
 *
 * The token expires at the window end, so this is only a backstop against a
 * caller passing a `validUntilMs` far in the future. Six hours is longer than
 * any single consultation.
 */
const VIDEO_TOKEN_MAX_TTL_SECONDS = 6 * 60 * 60;

/**
 * Mints a LiveKit access token.
 *
 * Claims are the LiveKit video grant, scoped to one room with publish and
 * subscribe rights and nothing else. `identity` is the user id, so a LiveKit
 * participant identity is the same account identity - a room's participant list
 * is therefore meaningful rather than being four anonymous device ids.
 */
export const mintLiveKitToken = (input: MintInput): string => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(
        Math.floor(input.validUntilMs / 1000),
        nowSeconds + VIDEO_TOKEN_MAX_TTL_SECONDS
    );

    if (expiresAt <= nowSeconds) {
        // Refusing rather than clamping: a caller reaching this has a bug in its
        // window arithmetic, and silently issuing a token that expires
        // immediately would fail confusingly at the client instead.
        throw new Error("Video token window has already closed");
    }

    return jwt.sign(
        {
            // `iss` is the API key, per the LiveKit token format. The secret is
            // the signing key and appears nowhere in the payload.
            iss: env.livekit.apiKey,
            sub: String(input.userId),
            nbf: nowSeconds,
            // A unique id per token. Lets a specific token be identified in
            // server logs if one is ever suspected of leaking.
            jti: crypto.randomBytes(12).toString("hex"),
            name: input.displayName,
            video: {
                room: input.roomName,
                roomJoin: true,
                canPublish: true,
                canSubscribe: true,
                canPublishData: true,
            },
        },
        env.livekit.apiSecret,
        { algorithm: "HS256", expiresIn: expiresAt - nowSeconds }
    );
};

/**
 * The provider in force, and whether it is usable.
 *
 * Falls back to jitsi rather than failing. That fallback is a deliberate
 * downgrade - it restores the old unauthenticated behaviour - so it is
 * reported rather than done quietly, and the client renders a banner saying the
 * session is not end-to-end authenticated. A clinician should be able to see
 * that, and should be able to see it in a log.
 */
export const activeProvider = (): { provider: VideoProviderName; degraded: boolean; reason?: string } => {
    if (env.videoProvider === "livekit") {
        if (!env.livekit.url || !env.livekit.apiKey || !env.livekit.apiSecret) {
            return {
                provider: "jitsi",
                degraded: true,
                reason: "VIDEO_PROVIDER=livekit but LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not all set",
            };
        }
        return { provider: "livekit", degraded: false };
    }
    return { provider: "jitsi", degraded: false };
};

/**
 * Builds the grant for a participant.
 *
 * `roomSeed` is the appointment's persisted room component. It lives on the
 * appointment row rather than being regenerated per request, because both
 * participants must independently arrive at the same room name.
 */
export const buildGrant = (input: GrantInput): VideoGrant => {
    const { provider, degraded, reason } = activeProvider();

    if (provider === "livekit") {
        const roomName = roomNameFor(input.appointmentId, input.roomSeed);
        return {
            provider: "livekit",
            room: roomName,
            token: mintLiveKitToken({ ...input, roomName }),
            identity: String(input.userId),
            displayName: input.displayName,
        };
    }

    if (degraded) {
        logger.warn(
            { reason },
            "Falling back to the unauthenticated video provider; sessions are not end-to-end authenticated"
        );
    }

    return {
        provider: "jitsi",
        // The historical shape: a random opaque URL and no credential. Kept only
        // as a degraded path.
        room: `https://meet.jit.si/MindEase-${input.appointmentId}-${crypto.randomBytes(8).toString("hex")}`,
        identity: String(input.userId),
        displayName: input.displayName,
    };
};
