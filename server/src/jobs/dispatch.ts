import { JOBS, type JobName } from "./registry";
import { logger } from "../utils/logger";

/**
 * Runs a job here, or asks the worker to run it.
 *
 * With `JOBS_WEBHOOK_URL` set, the API does not own the work: it calls the
 * worker's `POST /api/internal/jobs/:name` with `JOBS_SECRET`, and the process
 * whose lifetime is not the API's does the claiming. Without the URL the API
 * runs the job itself, which is the single-service default and what the worker
 * exercises directly.
 *
 * A failed trigger is logged and skipped rather than retried by the API: every
 * job's eligibility is a window or a sentinel, so the next tick - the worker's
 * own schedule, or this one - catches up whatever was missed. A delayed nudge is
 * the designed failure mode; a duplicated one is not, and the claims make sure
 * of that.
 */
export const dispatchJob = async (name: JobName): Promise<void> => {
    const baseUrl = process.env.JOBS_WEBHOOK_URL;
    if (!baseUrl) {
        await JOBS[name]();
        return;
    }

    const secret = process.env.JOBS_SECRET;
    if (!secret) {
        logger.error(
            { job: name },
            "JOBS_WEBHOOK_URL is set but JOBS_SECRET is not; refusing to trigger the worker unauthenticated"
        );
        return;
    }

    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/internal/jobs/${name}`;
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "X-Jobs-Secret": secret },
        });
        if (!response.ok) {
            logger.error(
                { job: name, status: response.status },
                "Worker refused the job trigger; waiting for the next tick"
            );
        }
    } catch (err) {
        logger.error(
            { job: name, err: err instanceof Error ? err.message : String(err) },
            "Could not reach the worker; waiting for the next tick"
        );
    }
};
