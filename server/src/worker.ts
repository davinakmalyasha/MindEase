/**
 * The standalone worker.
 *
 * Runs the same job registry on the same schedules as the API, without the API.
 * Its reason to exist is process lifetime: a redeploy, a crash or a
 * scale-to-zero of the API no longer takes the schedule with it.
 *
 * Deployment shape:
 *
 *   - Deploy this file as its own service (`npm run worker`), with the same
 *     environment as the API (database, Redis, mailer) plus nothing else.
 *   - Set `JOBS_WEBHOOK_URL` (this worker's public URL) and `JOBS_SECRET` on the
 *     API. The API's cron then forwards each tick here instead of running it;
 *     this process runs it locally, because `startJobs` with no `run` calls the
 *     registry directly.
 *
 * Both sides can run at the same time without duplicating work: every job
 * claims its rows conditionally, so two triggers produce one send. That is also
 * what makes the migration safe to do in either order.
 */
import { startJobs } from "./jobs/scheduler";
import { prisma } from "./lib/prisma";
import { logger } from "./utils/logger";

startJobs();

const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down the worker...`);
    await prisma.$disconnect();
    process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("Worker online: reminders, care check-ins, weekly reports");
