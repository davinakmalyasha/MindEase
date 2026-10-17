import cron from "node-cron";
import { JOBS, JOB_NAMES, SCHEDULES, type JobName } from "./registry";
import { logger } from "../utils/logger";

/**
 * Schedules the registry, one cron entry per job.
 *
 * `run` is what each tick does. The API passes `dispatchJob`, which either runs
 * the job here or forwards it to the worker; the worker passes nothing, which
 * runs the job locally. The same schedule table is used by both, so the two
 * cannot disagree about when a job is due.
 *
 * The tick is a trigger, not the work: every job is idempotent by claim, and a
 * missed tick is caught up by the next one because eligibility is a window or a
 * sentinel. That is what makes a duplicate or delayed trigger harmless.
 */
export const startJobs = (options: { run?: (name: JobName) => Promise<void> } = {}) => {
    if (process.env.NODE_ENV === "test") return;

    const run = options.run ?? ((name: JobName) => JOBS[name]());
    for (const name of JOB_NAMES) {
        cron.schedule(SCHEDULES[name], () => void run(name), { timezone: "Asia/Jakarta" });
    }
    logger.info(
        { jobs: JOB_NAMES.map((name) => `${name} ${SCHEDULES[name]}`) },
        "Background jobs scheduled (Asia/Jakarta)"
    );
};
