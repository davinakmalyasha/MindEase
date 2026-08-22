import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { prisma } from "../lib/prisma";


const JWT_SECRET = env.jwtSecret;

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies.accessToken || req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                role: true,
                email: true,
                name: true,
                isBanned: true,
                doctorProfile: { select: { id: true } },
            },
        });

        if (!user) {
            return res.status(401).json({ status: "error", message: "User not found" });
        }

        if (user.isBanned) {
            return res.status(403).json({ status: "error", message: "Account suspended. Contact support." });
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
        logger.warn({ err: error.message }, "Token verification failed");
        return res.status(401).json({ status: "error", message: "Invalid Token" });
    }
};
