/// <reference path="./types/index.d.ts" />
import dotenv from "dotenv";
dotenv.config();

import { createApp, prisma } from "./app";
import { logger } from "./utils/logger";
import { checkMailerStatus } from "./services/mailer.service";
import { env } from "./config/env";
import { initSentry } from "./utils/sentry";
import { startReminderJob } from "./jobs/reminders";
import { startCareCheckinJob } from "./jobs/checkins";

initSentry();

const PORT = env.port;

const app = createApp();

const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Environment: ${env.isProd ? "production" : env.isTest ? "test" : "development"}`);
    logger.info({ mailer: checkMailerStatus() }, "Mailer status");
    if (env.isProd && !env.googleClientId) {
        logger.warn("GOOGLE_CLIENT_ID is not set — Google sign-in is disabled");
    }
    startReminderJob();
    startCareCheckinJob();
});

// Graceful shutdown
const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(async () => {
        await prisma.$disconnect();
        logger.info("Server closed. Goodbye.");
        process.exit(0);
    });
    // Force-exit after 10s if connections linger
    setTimeout(() => process.exit(1), 10000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
