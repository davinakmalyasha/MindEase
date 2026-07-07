import { PrismaClient } from "@prisma/client";
import speakeasy from "speakeasy";
import qrcode from "qrcode";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

const APP_NAME = "MindEase";

export class TwoFactorService {
    static async generateSecret(user: { id: number; email: string }) {
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
        return { success: true };
    }

    static async disable(userId: number, code: string) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user?.totpSecret) throw new Error("2FA is not enabled");
        if (!this.verifyCode(user.totpSecret, code)) {
            throw new Error("Invalid code");
        }
        await prisma.user.update({
            where: { id: userId },
            data: { totpEnabled: false, totpSecret: null },
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
