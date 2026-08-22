import { prisma } from "../lib/prisma";
import speakeasy from "speakeasy";
import qrcode from "qrcode";
import argon2 from "argon2";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";


const JWT_SECRET = env.jwtSecret;

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
            if (!confirmed) throw new Error("Password confirmation required to regenerate two-factor authentication");
        }

        const secret = speakeasy.generateSecret({
            name: `${APP_NAME}:${user.email}`,
            issuer: APP_NAME,
        });

        await prisma.user.update({
            where: { id: user.id },
            data: { totpSecret: secret.base32 },
        });

        const otpauthUrl = secret.otpauth_url || "";
        const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

        return { secret: secret.base32, otpauthUrl, qrDataUrl };
    }

    static async enable(userId: number, code: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user?.totpSecret) throw new Error("Generate a secret first");
        if (!this.verifyCode(user.totpSecret, code)) {
            throw new Error("Invalid code");
        }
        await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } });

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
        let hashes: string[] = [];
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
        if (!user?.totpSecret || !user.totpEnabled) throw new Error("2FA is not enabled");
        if (!this.verifyCode(user.totpSecret, code)) {
            throw new Error("Invalid code");
        }
        // Disabling 2FA is sensitive: require both the TOTP code and a fresh
        // password confirmation.
        if (!password || !user.password || !(await argon2.verify(user.password, password))) {
            throw new Error("Password confirmation required to disable two-factor authentication");
        }
        await prisma.user.update({
            where: { id: userId },
            data: { totpEnabled: false, totpSecret: null, backupCodes: null },
        });
        return { success: true };
    }

    static verifyCode(secret: string, code: string) {
        return speakeasy.totp.verify({
            secret,
            encoding: "base32",
            token: code.trim(),
            window: 1,
        });
    }

    // Short-lived ticket used to complete a 2FA-protected login
    static issuePendingToken(userId: number) {
        return jwt.sign({ userId, totpPending: true }, JWT_SECRET, { expiresIn: "5m" });
    }

    static verifyPendingToken(token: string): number {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; totpPending?: boolean };
        if (!decoded.totpPending) throw new Error("Invalid token");
        return decoded.userId;
    }
}
