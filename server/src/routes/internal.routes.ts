import { Router } from "express";
import crypto from "crypto";
import { JOBS, isJobName } from "../jobs/registry";
import { publicMessageFor } from "../utils/appError";
import { logger } from "../utils/logger";

/**
 * The worker's trigger surface.
 *
 * When the API runs as one service this route is not configured and returns
 * 404. When a worker exists (`JOBS_WEBHOOK_URL` on the API, `JOBS_SECRET` on
 * both), the API's cron calls it instead of running the jobs itself, and the
 * process that is not redeployed with the API owns the schedule.
 *
 * It authenticates with a shared secret, not a session: there is no user, no
 * cookie and no CSRF token here. The comparison is constant-time so the
 * endpoint cannot be used as a timing oracle for the secret.
 *
 * Jobs are awaited so the worker's caller learns whether the tick completed,
 * and so the response is a meaningful acknowledgement rather than "accepted".
 * They are cheap by design (a query and some claim updates), and a slow tick
 * holding one worker request for seconds is the intended trade.
 */
const router = Router();

const secretMatches = (given: string | undefined, secret: string): boolean => {
    const a = Buffer.from(given ?? "");
    const b = Buffer.from(secret);
    // `timingSafeEqual` throws when lengths differ, so the length check has to
    // come first - and comparing lengths is not the secret being compared.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.post("/jobs/:name", async (req, res) => {
    const secret = process.env.JOBS_SECRET;
    if (!secret) {
        // Unconfigured means the endpoint does not exist. A trigger that runs
        // background work should be absent rather than open by default.
        return res.status(404).json({ status: "error", message: "Not found" });
    }
    if (!secretMatches(req.get("X-Jobs-Secret"), secret)) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    const name = req.params.name as string;
    if (!isJobName(name)) {
        return res.status(404).json({ status: "error", message: "Unknown job" });
    }

    try {
        await JOBS[name]();
        return res.json({ status: "success", data: { job: name } });
    } catch (error: unknown) {
        // Jobs log their own failures; this catches an unexpected rejection so
        // the caller sees a 500 rather than a hung connection.
        logger.error(
            { job: name, err: error instanceof Error ? error.message : String(error) },
            "Job trigger failed"
        );
        const { message, status } = publicMessageFor(error) ?? {
            message: "Job failed",
            status: 500,
        };
        return res.status(status).json({ status: "error", message });
    }
});

export default router;
