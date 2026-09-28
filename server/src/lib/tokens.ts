/**
 * Centralized JWT issuing and verification.
 *
 * Every token this application mints carries an explicit `purpose` claim and is
 * signed with a purpose-scoped secret. Verification always requires the
 * expected purpose, so a token minted for one flow can never be replayed into
 * another — in particular a pending two-factor ticket can never be presented
 * as an access token.
 */
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../config/env";

export type TokenPurpose = "access" | "refresh" | "2fa-pending";

const ISSUER = "mindease";
const ALGORITHMS: jwt.Algorithm[] = ["HS256"];

const ACCESS_TTL = "15m";
const REFRESH_TTL = "7d";
const TWO_FACTOR_TTL = "5m";

const secretFor = (purpose: TokenPurpose): string => {
    switch (purpose) {
        case "access":
            return env.jwtSecret;
        case "refresh":
            return env.refreshSecret;
        case "2fa-pending":
            return env.twoFactorSecret;
    }
};

const audienceFor = (purpose: TokenPurpose): string => `mindease:${purpose}`;

const sign = (
    purpose: TokenPurpose,
    payload: Record<string, unknown>,
    expiresIn: jwt.SignOptions["expiresIn"]
): string =>
    jwt.sign({ ...payload, purpose }, secretFor(purpose), {
        algorithm: ALGORITHMS[0],
        expiresIn,
        issuer: ISSUER,
        audience: audienceFor(purpose),
    });

/**
 * Verifies a token and asserts its purpose. A token issued for any other
 * purpose — or with no purpose at all — is rejected.
 */
export const verifyToken = <T extends jwt.JwtPayload = jwt.JwtPayload>(
    token: string,
    purpose: TokenPurpose
): T => {
    const decoded = jwt.verify(token, secretFor(purpose), {
        algorithms: ALGORITHMS,
        issuer: ISSUER,
        audience: audienceFor(purpose),
    });
    if (typeof decoded === "string" || decoded.purpose !== purpose) {
        throw new jwt.JsonWebTokenError(`Expected a "${purpose}" token`);
    }
    return decoded as T;
};

export interface AccessTokenClaims {
    userId: number;
    role: string;
    /** True when the session completed a second factor, or needs none. */
    totpVerified: boolean;
}

export const signAccessToken = (user: { id: number; role: string; totpVerified: boolean }): string =>
    sign(
        "access",
        { userId: user.id, role: user.role, totpVerified: user.totpVerified },
        ACCESS_TTL
    );

/**
 * Authentication methods satisfied when the session was established. A
 * refresh token only carries `otp` if the second factor was actually
 * completed, so a session minted before 2FA was enabled can never be
 * upgraded into a verified one.
 */
export type AuthMethod = "pwd" | "google" | "otp";

export const signRefreshToken = (userId: number, amr: AuthMethod[] = ["pwd"]): string =>
    sign("refresh", { userId, amr, jti: crypto.randomUUID() }, REFRESH_TTL);

export const signTwoFactorPendingToken = (userId: number): string =>
    sign("2fa-pending", { userId }, TWO_FACTOR_TTL);

/**
 * Refresh tokens are persisted as a SHA-256 digest so a database read (a
 * leaked backup, a rogue replica) cannot be replayed as a live session.
 */
export const hashToken = (token: string): string =>
    crypto.createHash("sha256").update(token).digest("hex");

/**
 * Verifies a candidate TOTP code without letting a replayed code inside the
 * +/- 1 step window mint a second session. Returns the accepted step, or
 * `null` when the code is invalid or has already been used.
 */
export const currentTotpStep = (): number => Math.floor(Date.now() / 1000 / 30);
