import { prisma } from "../lib/prisma";
import speakeasy from "speakeasy";
import qrcode from "qrcode";
import argon2 from "argon2";
import crypto from "crypto";
import { signTwoFactorPendingToken, verifyToken } from "../lib/tokens";
import { badRequest } from "../utils/appError";

const APP_NAME = "MindEase";

export class TwoFactorService {
    static async generateSecret(user: { id: number; email: string }, password?: string) {
        const existing = await prisma.user.findUnique({
            where: { id: user.id },
            select: { totpEnabled: true, password: true },
        });
        // Regenerating the secret of an ACTIVE 2FA setup would let a session
        // hijacker swap in their own device then legitimately disable 2FA.
        if (existing?.totpEnabled) {
            const confirmed = password && existing.password && (await argon2.verify(existing.password, password));
            if (!confirmed) throw badRequest("Password confirmation required to regenerate two-factor authentication");
        }

        const secret = speakeasy.generateSecret({
            name: `${APP_NAME}:${user.email}`,
            issuer: APP_NAME,
        });

        await prisma.user.update({
            where: { id: user.id },
            // A new secret invalidates any code accepted for the previous one.
            data: { totpSecret: secret.base32, lastTotpStep: null },
        });

        const otpauthUrl = secret.otpauth_url || "";
        const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

        return { secret: secret.base32, otpauthUrl, qrDataUrl };
    }

    static async enable(userId: number, code: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user?.totpSecret) throw badRequest("Generate a secret first");
        if (!this.verifyCode(user.totpSecret, code)) {
            throw badRequest("Invalid code");
        }
        await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } });

        // Enabling a second factor must not leave older sessions usable: a
        // refresh token obtained before this point would otherwise persist.
        const { AuthService } = await import("./auth.service");
        await AuthService.revokeAllSessions(userId, "2fa_enabled");

        // Single-use recovery codes, shown once and stored hashed
        const backupCodes = await this.generateBackupCodes(userId);

        return { success: true, backupCodes };
    }

    // 10 one-time recovery codes (argon2-hashed at rest, dash-separated pairs)
    static async generateBackupCodes(userId: number): Promise<string[]> {
        const codes = Array.from({ length: 10 }, () => {
            const raw = crypto.randomBytes(6).toString("hex").toUpperCase();
            return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
        });
        const hashes = await Promise.all(codes.map((c) => argon2.hash(c)));
        await prisma.user.update({
            where: { id: userId },
            data: { backupCodes: JSON.stringify(hashes) },
        });
        return codes;
    }

    /** Returns true and consumes the code when it matches an unused backup. */
    static async consumeBackupCode(userId: number, code: string): Promise<boolean> {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { backupCodes: true } });
        if (!user?.backupCodes) return false;
        let hashes: string[];
        try {
            hashes = JSON.parse(user.backupCodes);
        } catch {
            return false;
        }
        const candidate = code.trim().toUpperCase();
        for (const hash of hashes) {
            if (await argon2.verify(hash, candidate)) {
                const remaining = hashes.filter((h) => h !== hash);
                await prisma.user.update({
                    where: { id: userId },
                    data: { backupCodes: remaining.length ? JSON.stringify(remaining) : null },
                });
                return true;
            }
        }
        return false;
    }

    static async disable(userId: number, code: string, password?: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user?.totpSecret || !user.totpEnabled) throw badRequest("2FA is not enabled");
        if (!this.verifyCode(user.totpSecret, code)) {
            throw badRequest("Invalid code");
        }
        // Disabling 2FA is sensitive: require both the TOTP code and a fresh
        // password confirmation.
        if (!password || !user.password || !(await argon2.verify(user.password, password))) {
            throw badRequest("Password confirmation required to disable two-factor authentication");
        }
        await prisma.user.update({
            where: { id: userId },
            data: { totpEnabled: false, totpSecret: null, backupCodes: null, lastTotpStep: null },
        });

        // Sessions established while 2FA was on carried an `otp` assurance
        // claim. Drop them so nothing survives the downgrade.
        const { AuthService } = await import("./auth.service");
        await AuthService.revokeAllSessions(userId, "2fa_disabled");

        return { success: true };
    }

    /**
     * The clock, as a test seam.
     *
     * A TOTP code is a function of a 30-second time step, and the +/- 1 step
     * tolerance is the only thing absorbing latency between a client minting a
     * code and the server verifying it. On a loaded machine a single Argon2
     * re-hash inside a test can take longer than a whole step, so a code minted
     * at the start of a request is stale by the time it is checked — and the
     * failure surfaces far from its cause, as a downstream assertion about
     * `totpEnabled`.
     *
     * Pinning the clock inside the *current* step keeps every test inside the
     * window a real authenticator would satisfy, without changing any
     * production behaviour: the tolerance, the replay guard and the signing all
     * behave identically.
     */
    private static pinnedNow: number | null = null;

    /** Freezes the service clock. `null` restores the system clock. */
    static __pinNow(epochMs: number | null) {
        TwoFactorService.pinnedNow = epochMs;
    }

    /** The current step, honouring {@link __pinNow}. */
    static currentStep(): number {
        const now = TwoFactorService.pinnedNow ?? Date.now();
        return Math.floor(now / 1000 / 30);
    }

    static verifyCode(secret: string, code: string) {
        // speakeasy's option is `time` (seconds), not `epoch` — passing `epoch`
        // is silently ignored and the check then fails against a real code.
        const time = Math.floor((TwoFactorService.pinnedNow ?? Date.now()) / 1000);
        return speakeasy.totp.verify({
            secret,
            encoding: "base32",
            token: code.trim(),
            window: 1,
            time,
        });
    }

    /**
     * Consumes a TOTP step, rejecting a code that has already been accepted.
     * The +/- 1 step tolerance window means the same six digits stay valid for
     * roughly 90 seconds, so without this a captured code could be replayed
     * repeatedly to mint additional sessions.
     */
    static async consumeTotpStep(userId: number, secret: string, code: string): Promise<boolean> {
        if (!this.verifyCode(secret, code)) return false;

        const step = this.currentStep();
        const accepted = await prisma.user.updateMany({
            where: {
                id: userId,
                OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }],
            },
            data: { lastTotpStep: step },
        });

        return accepted.count === 1;
    }

    /**
     * Short-lived ticket used only to complete a 2FA-protected login. It is
     * signed with a purpose-scoped secret, so it cannot be presented as an
     * access token to any authenticated route.
     */
    static issuePendingToken(userId: number) {
        return signTwoFactorPendingToken(userId);
    }

    static verifyPendingToken(token: string): number {
        const decoded = verifyToken<{ userId: number }>(token, "2fa-pending");
        if (typeof decoded.userId !== "number") throw badRequest("Invalid token");
        return decoded.userId;
    }
}
