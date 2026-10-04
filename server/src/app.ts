/// <reference path="./types/index.d.ts" />
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
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
import realtimeRoutes from "./routes/realtime.routes";
import paymentRoutes from "./routes/payment.routes";
import carePlanRoutes from "./routes/carePlan.routes";
import { csrfProtect, csrfTokenHandler } from "./middleware/csrf.middleware";
import { openApiDocument } from "./docs/openapi";
import { captureError } from "./utils/sentry";
import swaggerUi from "swagger-ui-express";
import { sharedLimiter } from "./middleware/rateLimit.middleware";

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
    app.use(
        express.json({
            limit: "1mb",
            // Keep the byte-for-byte payload on the request. Payment provider
            // signatures (Midtrans included) are computed over the exact bytes
            // they sent; a parsed-then-re-serialised body reorders keys and
            // changes whitespace, so signature verification against
            // `req.body` fails on legitimate callbacks. The cost is a string
            // copy per JSON request, which only the webhook route reads.
            verify: (req, _res, buf) => {
                if (buf && buf.length) {
                    (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
                }
            },
        })
    );
    app.use(cookieParser());
    // Structured access logging, so a request can be joined to its log lines
    // and its Sentry event by `requestId`.
    //
    // The previous `morgan("dev")` wrote a colourised human string nested
    // opaquely inside a JSON record. The comment above this block used to claim
    // that the switch also removed query strings from the logs. It did not.
    // pino-http's default request serialiser emits `url` including the query, and
    // `redact` in utils/logger.ts has no `req.url` path, so
    // `GET /api/admin/users?search=<patient email>` wrote that patient's email
    // address into the log store - retained, searchable, and visible to anyone
    // with dashboard access. The same applies to `/api/doctors?q=<free text>` and
    // every other query-bearing route.
    app.use(
        pinoHttp({
            logger,
            genReqId: (req) =>
                (req as express.Request & { requestId?: string }).requestId ?? crypto.randomUUID(),
            serializers: {
                // Shape mirrors pino's default request serialiser minus the query
                // *values*. `query` keeps its keys, so a request is still
                // diagnosable ("they called /api/doctors with page=2 and no
                // specialty") without the log ever holding a search term, which
                // for the admin user list is an email address.
                //
                // Headers are still emitted so the `redact` list in
                // utils/logger.ts continues to apply to them.
                req: (req) => {
                    const raw = req.raw ?? req;
                    const q = (raw as express.Request).query ?? {};
                    const queryKeys =
                        q && typeof q === "object" ? Object.keys(q as Record<string, unknown>) : [];
                    return {
                        method: raw.method,
                        // Path only. Never the query string.
                        url: raw.url ? String(raw.url).split("?")[0] : raw.url,
                        queryKeys,
                        headers: raw.headers,
                        remoteAddress: raw.socket?.remoteAddress,
                        remotePort: raw.socket?.remotePort,
                    };
                },
            },
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

    // General API rate limit: 300 requests / 15 min / IP.
    //
    // `sharedLimiter` rather than a bare `rateLimit({...})`. This one was missed
    // when the Redis-backed store was introduced, so it kept the default
    // per-process `MemoryStore` - meaning the ceiling most requests are actually
    // governed by was doubled on two replicas and reset on every rolling deploy,
    // while `docs/security.md` listed it as Redis-backed. The store is now
    // something you get by using the one constructor, and
    // `tests/rate-limit-store.test.ts` proves no bare `rateLimit({` is left.
    //
    // Defined outside the NODE_ENV guard because `/api/docs` reuses it below.
    // Skipping in tests keeps the suite from having to share one IP's budget
    // across several hundred assertions, which is the only reason the mount is
    // conditional.
    const generalLimiter = sharedLimiter("general", {
        windowMs: 15 * 60 * 1000,
        max: 300,
        message: { status: "error", message: "Too many requests, please slow down" },
    });

    if (process.env.NODE_ENV !== "test") {
        app.use("/api", (req, res, next) => {
            // Health checks and CSRF bootstrap are exempt (monitoring must always
            // work). `/docs` is no longer exempt: it now has its own limiter
            // rather than none at all.
            if (req.path.startsWith("/health") || req.path === "/csrf-token") {
                return next();
            }
            return generalLimiter(req, res, next);
        });
    }

    // CSRF protection for all mutating API routes (double-submit token).
    //
    // The payment provider's callback is exempt: the caller is a payment
    // gateway with no cookie and no header, and CSRF is a defence against a
    // browser being induced to issue an authenticated request. That threat does
    // not apply here — the route is authenticated by the provider's own
    // signature, verified in the provider implementation.
    app.use("/api", (req, res, next) => {
        if (req.path === "/payments/notification") return next();
        return csrfProtect(req, res, next);
    });
    app.get("/api/csrf-token", csrfTokenHandler);

    app.use(
    "/uploads",
    express.static(path.join(__dirname, "../public/uploads"), {
        setHeaders: (res, filePath) => {
            // Served from the API's own origin, which is the origin that holds
            // the session cookies. `httpOnly` stops script reading them, but the
            // file is still same-origin content.
            //
            // `Content-Security-Policy: default-src 'none'; sandbox` means that
            // even if someone later adds `.svg` to an upload allowlist, the
            // result is an inert file rather than a script that runs on the
            // credential origin. It is one allowlist entry away from being stored
            // XSS today, which is the part worth defending against.
            res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
            res.setHeader("X-Content-Type-Options", "nosniff");
            // Anything that is not an image is a download rather than something
            // the browser renders in place. Images stay inline so avatars work.
            if (!/\.(png|jpe?g|webp|gif)$/i.test(filePath)) {
                res.setHeader("Content-Disposition", "attachment");
            }
        },
    })
);

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
    //
    // Served only outside production, and behind the same per-IP limiter as the
    // rest of the API.
    //
    // It was mounted unconditionally and *exempted* from the general limiter, so
    // the entire attack surface was anonymously readable - every route, every
    // request schema, the exact cookie and CSRF header names, and the fact that
    // the payment webhook is signature-authenticated rather than
    // session-authenticated. An exemption is the wrong tool here: it removes a
    // ceiling rather than adding one.
    //
    // In production the spec is still available, machine-readable, at
    // `/api/openapi.json` - which is what a client generator or a reviewer
    // actually wants, and which is not a browsable UI.
    if (!env.isProd) {
        app.use(
            "/api/docs",
            generalLimiter,
            swaggerUi.serve,
            swaggerUi.setup(openApiDocument)
        );
    }
    // The document itself is not sensitive, and gating it would break the
    // generated clients a portfolio reviewer will point at this.
    app.get("/api/openapi.json", (_req, res) => {
        res.json(openApiDocument);
    });

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
app.use("/api/realtime", realtimeRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api", carePlanRoutes);

    // 404 handler
    app.use((req, res) => {
        // The path is not reflected: it is attacker-controlled free text, and
        // echoing it back is a log-injection vector into our own log store.
        res.status(404).json({ status: "error", message: "Route not found" });
    });

    // Global Error Handler
    // Express identifies an error handler by its four-parameter arity, so `next`
    // has to stay even though this handler always terminates the response.
    app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
