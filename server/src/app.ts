/// <reference path="./types/index.d.ts" />
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import path from "path";
import crypto from "crypto";
import { logger } from "./utils/logger";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { publicMessageFor } from "./utils/appError";
import authRoutes from "./routes/auth.routes";
import accountRoutes from "./routes/account.routes";
import doctorRoutes from "./routes/doctor.routes";
import appointmentRoutes from "./routes/appointment.routes";
import userRoutes from "./routes/user.routes";
import adminRoutes from "./routes/admin.routes";
import reviewRoutes from "./routes/review.routes";
import notificationRoutes from "./routes/notification.routes";
import aiRoutes from "./routes/ai.routes";
import wellnessRoutes from "./routes/wellness.routes";
import messageRoutes from "./routes/message.routes";
import supportRoutes from "./routes/support.routes";
import followUpRoutes from "./routes/followUp.routes";
import pushRoutes from "./routes/push.routes";
import { csrfProtect, csrfTokenHandler } from "./middleware/csrf.middleware";
import { openApiDocument } from "./docs/openapi";
import { captureError } from "./utils/sentry";
import swaggerUi from "swagger-ui-express";

export { prisma };

export const createApp = () => {
    const app = express();

    // Behind Railway/Vercel proxies req.ip must be the client IP, otherwise
    // every rate limiter would share one platform-wide bucket.
    app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);

    // Request-ID middleware
    //
    // The id is attached to the *request* as well as the response, and the
    // inbound value is only honoured when it looks like an id. Previously the
    // id was generated onto the response but the error handler read the inbound
    // header — which is normally absent — so the id in a log line and the id the
    // client saw could never be joined, and an attacker could inject arbitrary
    // text into the log stream via the header.
    app.use((req, res, next) => {
        const inbound = req.headers["x-request-id"];
        const requestId =
            typeof inbound === "string" && /^[\w-]{1,64}$/.test(inbound) ? inbound : crypto.randomUUID();
        (req as express.Request & { requestId?: string }).requestId = requestId;
        res.setHeader("X-Request-Id", requestId);
        next();
    });

    // Security Middlewares
    app.use(
        helmet({
            crossOriginResourcePolicy: { policy: "cross-origin" },
        })
    );
    app.use(
        cors({
            origin: env.corsOrigins,
            credentials: true,
        })
    );
    app.use(express.json({ limit: "1mb" }));
    app.use(cookieParser());
    // Structured access logging, so a request can be joined to its log lines
    // and its Sentry event by `requestId`. The previous `morgan("dev")` wrote a
    // colourised human string — including the full query string, which for
    // `/api/admin/users?search=<email>` is PII — nested opaquely inside a JSON
    // log record.
    app.use(
        pinoHttp({
            logger,
            genReqId: (req) =>
                (req as express.Request & { requestId?: string }).requestId ?? crypto.randomUUID(),
            autoLogging: {
                // Health checks would otherwise dominate the log volume.
                ignore: (req) => req.url?.startsWith("/api/health") ?? false,
            },
            customLogLevel: (_req, res, err) => {
                if (err || res.statusCode >= 500) return "error";
                if (res.statusCode >= 400) return "warn";
                return "info";
            },
        })
    );

    // General API rate limit: 300 requests / 15 min / IP (disabled in tests)
    if (process.env.NODE_ENV !== "test") {
        const generalLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 300,
            message: { status: "error", message: "Too many requests, please slow down" },
            standardHeaders: true,
            legacyHeaders: false,
        });
        app.use("/api", (req, res, next) => {
            // Health checks and CSRF bootstrap are exempt (monitoring must always work)
            if (req.path.startsWith("/health") || req.path === "/csrf-token" || req.path === "/docs") {
                return next();
            }
            return generalLimiter(req, res, next);
        });
    }

    // CSRF protection for all mutating API routes (double-submit token)
    app.use("/api", csrfProtect);
    app.get("/api/csrf-token", csrfTokenHandler);

    app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));

    // Health checks
    app.get("/api/health", (req, res) => {
        res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
    });
    app.get("/api/health/db", async (req, res) => {
        try {
            await prisma.$queryRaw`SELECT 1`;
            res.json({ status: "ok", db: "connected" });
        } catch (error: any) {
            logger.error({ err: error.message }, "DB health check failed");
            res.status(503).json({ status: "error", db: "unreachable" });
        }
    });

    // API documentation (Swagger UI)
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

    // Routes
    app.use("/api/auth", authRoutes);
    app.use("/api/account", accountRoutes);
    app.use("/api/doctors", doctorRoutes);
    app.use("/api/appointments", appointmentRoutes);
    app.use("/api/users", userRoutes);
    app.use("/api/admin", adminRoutes);
    app.use("/api/reviews", reviewRoutes);
    app.use("/api/notifications", notificationRoutes);
    app.use("/api/ai", aiRoutes);
    app.use("/api/wellness", wellnessRoutes);
    app.use("/api/messages", messageRoutes);
    app.use("/api/support", supportRoutes);
    app.use("/api", followUpRoutes);
    app.use("/api/push", pushRoutes);

    // 404 handler
    app.use((req, res) => {
        // The path is not reflected: it is attacker-controlled free text, and
        // echoing it back is a log-injection vector into our own log store.
        res.status(404).json({ status: "error", message: "Route not found" });
    });

    // Global Error Handler
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        const requestId = (req as express.Request & { requestId?: string }).requestId;
        logger.error({ err: err?.stack || String(err), path: req.path, requestId }, "Unhandled error");
        captureError(err, { path: req.path, method: req.method, requestId });

        // Only errors explicitly deemed safe to disclose reach the client with
        // their own message. Everything else — Prisma invocation text, driver
        // errors, stack-bearing errors — is reported as a generic failure, so a
        // malformed request cannot be used to fingerprint the schema.
        const disclosed = publicMessageFor(err);
        if (disclosed) {
            return res.status(disclosed.status).json({
                status: "error",
                message: disclosed.message,
                ...(disclosed.details ? { ...disclosed.details } : {}),
            });
        }

        res.status(500).json({
            status: "error",
            message: "Something went wrong. Please try again.",
            ...(requestId ? { requestId } : {}),
        });
    });

    return app;
};
