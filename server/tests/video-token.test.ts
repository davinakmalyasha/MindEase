import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

/**
 * Video session credentials.
 *
 * Every case here is about one of the four invariants: room-scoped,
 * short-lived, participant-bound, and never exposing the signing secret. These
 * are the properties that make a consultation private; the provider itself is
 * replaceable, the invariants are not.
 *
 * The LiveKit configuration is not repeated here. It lives in
 * `tests/global-setup.ts`, which is the only place in the suite where
 * `config/env.ts` can still see it: `tests/setup.ts` imports `../src/app`, so
 * it - and any test file - has its `process.env` assignments hoisted above the
 * moment `env.ts` snapshots them. Every case in this file was failing against
 * an empty API secret before that moved.
 */
import { mintLiveKitToken, buildGrant, roomNameForTest } from "../src/services/video.service";
import { env } from "../src/config/env";

const decode = (token: string) => jwt.decode(token) as Record<string, never>;
const minute = 60_000;

const mint = (overrides: Partial<Parameters<typeof mintLiveKitToken>[0]> = {}) =>
    mintLiveKitToken({
        appointmentId: 42,
        userId: 7,
        displayName: "A. Participant",
        roomName: "mindease-42-abc123",
        validUntilMs: Date.now() + 60 * minute,
        ...overrides,
    });

describe("mintLiveKitToken", () => {
    it("is signed with the API secret, so the client cannot forge one", () => {
        const token = mint();

        // Verifies against the secret, and throws if the signature is wrong.
        const claims = jwt.verify(token, env.livekit.apiSecret, { algorithms: ["HS256"] }) as Record<
            string,
            never
        >;
        expect(claims.sub).toBe("7");
    });

    it("rejects a token signed with anything other than the API secret", () => {
        // The forgery a client would attempt with no server access at all.
        const forged = jwt.sign({ sub: "1", video: { room: "mindease-1-x" } }, "not-the-secret", {
            algorithm: "HS256",
        });

        expect(() => jwt.verify(forged, env.livekit.apiSecret, { algorithms: ["HS256"] })).toThrow();
    });

    it("grants exactly one room and nothing else", () => {
        const token = mint();
        const video = decode(token).video as unknown as Record<string, unknown>;

        expect(video.room).toBe("mindease-42-abc123");
        // Scoped to a single room is the property that stops a token from one
        // consultation being replayed against another.
        expect(video.roomJoin).toBe(true);
    });

    it("expires at the end of the session window, not at a fixed horizon", () => {
        const shortSession = mint({ validUntilMs: Date.now() + 5 * minute });
        const longSession = mint({ validUntilMs: Date.now() + 3 * 60 * minute });

        const shortExp = decode(shortSession).exp as unknown as number;
        const longExp = decode(longSession).exp as unknown as number;

        expect(longExp).toBeGreaterThan(shortExp);
        // A five-minute session must not hand out an hour.
        expect(shortExp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(5 * 60 + 2);
    });

    it("caps the token lifetime so a bad window cannot mint a long-lived credential", () => {
        const absurd = mint({ validUntilMs: Date.now() + 365 * 24 * 60 * minute });

        const ttl = (decode(absurd).exp as unknown as number) - Math.floor(Date.now() / 1000);
        expect(ttl).toBeLessThanOrEqual(6 * 60 * 60 + 2);
    });

    it("refuses to mint for a window that has already closed", () => {
        // Throwing rather than clamping: a caller reaching this has a bug in its
        // window arithmetic, and a token that expires immediately would fail at
        // the client instead, with a much worse error.
        expect(() => mint({ validUntilMs: Date.now() - minute })).toThrow(/already closed/i);
    });

    it("never contains the API secret", () => {
        const token = mint();
        // The payload is base64url-encoded, so decode and look at the claims too.
        expect(token).not.toContain(env.livekit.apiSecret);
        expect(JSON.stringify(decode(token))).not.toContain(env.livekit.apiSecret);
    });

    it("binds the token to the user id, so a LiveKit identity is a real identity", () => {
        const token = mint({ userId: 99 });
        expect(decode(token).sub).toBe("99");
    });

    it("gives each token a unique id, so a suspect one can be identified", () => {
        const a = decode(mint()).jti as unknown as string;
        const b = decode(mint()).jti as unknown as string;
        expect(a).not.toBe(b);
    });
});

describe("buildGrant", () => {
    it("returns a livekit grant with a token when configured", () => {
        const grant = buildGrant({
            appointmentId: 42,
            userId: 7,
            displayName: "A. Participant",
            roomSeed: "abc123",
            validUntilMs: Date.now() + 60 * minute,
        });

        expect(grant.provider).toBe("livekit");
        expect(grant.token).toBeTruthy();
        expect(grant.room).toBe(roomNameForTest(42, "abc123"));
    });

    it("gives both participants the same room for the same appointment", () => {
        const common = { appointmentId: 42, roomSeed: "abc123", validUntilMs: Date.now() + 60 * minute };
        const patient = buildGrant({ ...common, userId: 1, displayName: "Patient" });
        const doctor = buildGrant({ ...common, userId: 2, displayName: "Doctor" });

        // They join independently and must arrive at the same place, or the
        // symptom is "the other person never joined".
        expect(patient.room).toBe(doctor.room);
        // But the tokens differ, because they are bound to different identities.
        expect(patient.token).not.toBe(doctor.token);
    });

    it("gives different appointments different rooms", () => {
        const base = { userId: 1, displayName: "A", validUntilMs: Date.now() + 60 * minute, roomSeed: "s" };
        const first = buildGrant({ ...base, appointmentId: 1 });
        const second = buildGrant({ ...base, appointmentId: 2 });
        expect(first.room).not.toBe(second.room);
    });
});
