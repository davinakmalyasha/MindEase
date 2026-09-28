import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../lib/prisma";
import { verifyToken, type AccessTokenClaims } from "../lib/tokens";

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies.accessToken || req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    let claims: AccessTokenClaims;
    try {
        // Verifying with an explicit purpose means a refresh token or a pending
        // two-factor ticket can never authenticate a request.
        claims = verifyToken<AccessTokenClaims>(token, "access");
    } catch (error: any) {
        logger.warn({ err: error.message }, "Token verification failed");
        return res.status(401).json({ status: "error", message: "Invalid Token" });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { id: claims.userId },
            select: {
                id: true,
                role: true,
                email: true,
                name: true,
                isBanned: true,
                totpEnabled: true,
                doctorProfile: { select: { id: true } },
            },
        });

        if (!user) {
            return res.status(401).json({ status: "error", message: "User not found" });
        }

        if (user.isBanned) {
            return res.status(403).json({ status: "error", message: "Account suspended. Contact support." });
        }

        // A session for a user who has since enabled 2FA is only valid if it
        // actually completed the second factor. Enabling 2FA therefore revokes
        // every pre-existing session immediately.
        if (user.totpEnabled && !claims.totpVerified) {
            logger.warn({ userId: user.id }, "Rejected access token without a completed second factor");
            return res.status(401).json({
                status: "error",
                message: "Two-factor verification required",
                code: "TOTP_REQUIRED",
            });
        }

        req.user = {
            id: user.id,
            role: user.role,
            email: user.email,
            name: user.name ?? null,
            doctorProfileId: user.doctorProfile?.id ?? null,
        };
        next();
    } catch (error: any) {
        logger.error({ err: error.message }, "Auth middleware failure");
        return res.status(500).json({ status: "error", message: "Internal Server Error" });
    }
};
