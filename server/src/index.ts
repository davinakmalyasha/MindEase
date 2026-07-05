/// <reference path="./types/index.d.ts" />
import dotenv from "dotenv";
dotenv.config();

import { createApp, prisma } from "./app";
import { logger } from "./utils/logger";

const PORT = process.env.PORT || 5000;

const app = createApp();

const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
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
