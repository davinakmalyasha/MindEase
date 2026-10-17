import { runReminders, runWeeklyReports } from "./reminders";
import { runCareCheckins } from "./checkins";

/**
 * The scheduled jobs, by the name the trigger and the worker use.
 *
 * One registry rather than a `switch` in two places: the API's webhook trigger
 * and the standalone worker both resolve work through this object, so a new job
 * is added once. It is also the seam tests spy through - an imported binding
 * could not be replaced at call time.
 */
export const JOBS = {
    reminders: runReminders,
    checkins: runCareCheckins,
    "weekly-reports": runWeeklyReports,
} as const;

export type JobName = keyof typeof JOBS;

export const JOB_NAMES = Object.keys(JOBS) as JobName[];

/**
 * The schedules, kept beside the jobs so the worker and the API's fallback
 * cannot drift apart. `Asia/Jakarta` for all three: the report's week boundary
 * and the check-in hour are both meant in the product's timezone.
 */
export const SCHEDULES: Record<JobName, string> = {
    reminders: "*/10 * * * *",
    checkins: "0 9 * * *",
    "weekly-reports": "0 7 * * *",
};

export const isJobName = (name: string): name is JobName =>
    (JOB_NAMES as string[]).includes(name);
