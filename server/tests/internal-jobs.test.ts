import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupClient } from "./helpers";
import { JOBS } from "../src/jobs/registry";
import { dispatchJob } from "../src/jobs/dispatch";

/**
 * The worker trigger and the API's dispatch seam.
 *
 * The route exists only when `JOBS_SECRET` is configured, and only a caller with
 * the secret can make it run a job. The jobs are replaced with spies: this file
 * is about the door, not about what happens behind it - each job has its own
 * tests for the work.
 */

const post = (agent: any, name: string, secret?: string) =>
    agent.post(`/api/internal/jobs/${name}`).set("X-Jobs-Secret", secret ?? "");

describe("worker job trigger", () => {
    const original = process.env.JOBS_SECRET;

    beforeEach(() => {
        delete process.env.JOBS_SECRET;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (original === undefined) delete process.env.JOBS_SECRET;
        else process.env.JOBS_SECRET = original;
    });

    it("does not exist when no secret is configured", async () => {
        const { agent } = await setupClient();
        const res = await post(agent, "reminders", "anything");
        expect(res.status).toBe(404);
    });

    it("rejects a missing or wrong secret without running anything", async () => {
        process.env.JOBS_SECRET = "worker-secret";
        const spy = vi.spyOn(JOBS, "reminders").mockResolvedValue(undefined);
        const { agent } = await setupClient();

        expect((await post(agent, "reminders")).status).toBe(401);
        expect((await post(agent, "reminders", "wrong")).status).toBe(401);
        expect(spy).not.toHaveBeenCalled();
    });

    it("runs exactly the named job when the secret matches", async () => {
        process.env.JOBS_SECRET = "worker-secret";
        const reminders = vi.spyOn(JOBS, "reminders").mockResolvedValue(undefined);
        const checkins = vi.spyOn(JOBS, "checkins").mockResolvedValue(undefined);
        const { agent } = await setupClient();

        const res = await post(agent, "reminders", "worker-secret");
        expect(res.status).toBe(200);
        expect(res.body.data.job).toBe("reminders");
        expect(reminders).toHaveBeenCalledTimes(1);
        expect(checkins).not.toHaveBeenCalled();
    });

    it("rejects an unknown job name", async () => {
        process.env.JOBS_SECRET = "worker-secret";
        const { agent } = await setupClient();
        const res = await post(agent, "everything", "worker-secret");
        expect(res.status).toBe(404);
    });
});

describe("job dispatch", () => {
    const originalUrl = process.env.JOBS_WEBHOOK_URL;
    const originalSecret = process.env.JOBS_SECRET;

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        const restore = (key: string, value: string | undefined) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        };
        restore("JOBS_WEBHOOK_URL", originalUrl);
        restore("JOBS_SECRET", originalSecret);
    });

    it("runs locally when no worker URL is configured", async () => {
        delete process.env.JOBS_WEBHOOK_URL;
        const spy = vi.spyOn(JOBS, "checkins").mockResolvedValue(undefined);

        await dispatchJob("checkins");
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("posts to the worker with the secret when configured", async () => {
        process.env.JOBS_WEBHOOK_URL = "https://worker.test/";
        process.env.JOBS_SECRET = "worker-secret";
        const local = vi.spyOn(JOBS, "checkins").mockResolvedValue(undefined);
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal("fetch", fetchMock);

        await dispatchJob("checkins");

        expect(local).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://worker.test/api/internal/jobs/checkins");
        expect(init.method).toBe("POST");
        expect(init.headers["X-Jobs-Secret"]).toBe("worker-secret");
    });

    it("does not call the worker unauthenticated when the URL is set but the secret is not", async () => {
        process.env.JOBS_WEBHOOK_URL = "https://worker.test";
        delete process.env.JOBS_SECRET;
        const local = vi.spyOn(JOBS, "weekly-reports").mockResolvedValue(undefined);
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await dispatchJob("weekly-reports");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(local).not.toHaveBeenCalled();
    });
});
