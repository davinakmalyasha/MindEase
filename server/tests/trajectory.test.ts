import { describe, it, expect } from "vitest";
import request from "supertest";
import { createUser, createDoctor, app } from "./helpers";
import { prisma } from "../src/app";

/**
 * GET /api/wellness/assessments/trajectory
 *
 * The longitudinal view of a patient's own screening history. Every assertion
 * here is about a claim the response makes *about a person* - which instrument
 * a point belongs to, what band its score falls in, and above all whether the
 * service is willing to call the change a trend - so the assertions are on the
 * wording of the response and on the rows behind it, never on the query that
 * produced them.
 */

type Instrument = "phq9" | "gad7";

const QUESTION_COUNTS: Record<Instrument, number> = { phq9: 9, gad7: 7 };

/**
 * A valid answer vector summing to `total`.
 *
 * The last item is deliberately left at zero. A non-zero PHQ-9 item 9 is a
 * disclosure of thoughts of self-harm, which raises a RiskAlert and assigns it
 * to a clinician; that path is `clinicalSafety.service`'s business and is
 * covered in `risk-queue.test.ts`. Leaving it clear keeps these tests about the
 * trajectory arithmetic and keeps the max reachable score at 24 (PHQ-9) and 18
 * (GAD-7) rather than 27 and 21.
 */
const answersFor = (total: number, instrument: Instrument): number[] => {
    const count = QUESTION_COUNTS[instrument];
    const answers = new Array<number>(count).fill(0);
    let left = total;
    for (let i = 0; i < count - 1 && left > 0; i++) {
        const take = Math.min(3, left);
        answers[i] = take;
        left -= take;
    }
    return answers;
};

/**
 * Submits a sitting through the real HTTP endpoint, then pins its `createdAt`
 * to a distinct, known instant.
 *
 * The submission is the patient's own path on purpose - the score and severity
 * under test are the ones the server derives from the answers, not ones this
 * file writes directly. Only the timestamp is adjusted: three requests inside
 * the same millisecond are indistinguishable to a `datetime(3)` column, and the
 * series order is one of the things being asserted, so leaving it to whatever
 * the storage engine happened to return would make the ordering assertions a
 * race rather than a check. `slot` is the position in the series, so the
 * backdating is monotonic and total.
 */
const sit = async (user: { agent: any; csrf: string }, instrument: Instrument, total: number, slot: number) => {
    const res = await user.agent
        .post("/api/wellness/assessments")
        .set("X-CSRF-Token", user.csrf)
        .send({ type: instrument, answers: answersFor(total, instrument) });
    expect(res.status).toBe(201);
    // Derived server-side from the answers, so the trajectory is checked against
    // the same arithmetic the patient produces rather than a number we chose.
    expect(res.body.data.score).toBe(total);
    await prisma.assessment.update({
        where: { id: res.body.data.id },
        data: { createdAt: new Date(Date.UTC(2026, 0, 1 + slot, 9, 0, 0)) },
    });
    return res.body.data;
};

const get = (user: { agent: any }, query: string) =>
    user.agent.get(`/api/wellness/assessments/trajectory?${query}`);

describe("GET /api/wellness/assessments/trajectory - which instrument", () => {
    it("keeps PHQ-9 and GAD-7 as separate series", async () => {
        // The two scales have different maxima and different band edges, so a
        // response that mixed them would put incomparable numbers on one axis
        // and label them with the wrong clinical words.
        const user = await createUser("patient");
        await sit(user, "phq9", 12, 0);
        await sit(user, "gad7", 3, 1);

        const phq = await get(user, "type=phq9");
        expect(phq.status).toBe(200);
        expect(phq.body.data.type).toBe("phq9");
        expect(phq.body.data.instrument.label).toBe("PHQ-9");
        expect(phq.body.data.instrument.max).toBe(27);
        expect(phq.body.data.points.map((p: { score: number }) => p.score)).toEqual([12]);

        const gad = await get(user, "type=gad7");
        expect(gad.status).toBe(200);
        expect(gad.body.data.type).toBe("gad7");
        expect(gad.body.data.instrument.label).toBe("GAD-7");
        expect(gad.body.data.instrument.max).toBe(21);
        expect(gad.body.data.points.map((p: { score: number }) => p.score)).toEqual([3]);
    });

    it("ships each instrument's own severity bands rather than one shared list", async () => {
        // `bands` exists so a chart cannot hardcode its own cut-offs. The two
        // instruments genuinely differ - PHQ-9 has a `moderately-severe` step
        // that GAD-7 does not - so a shared list would mislabel one of them.
        const user = await createUser("patient");

        const phq = await get(user, "type=phq9");
        const gad = await get(user, "type=gad7");

        expect(phq.body.data.instrument.bands.length).toBe(5);
        expect(gad.body.data.instrument.bands.length).toBe(4);
        expect(phq.body.data.instrument.bands.map((b: { severity: string }) => b.severity)).toContain(
            "moderately-severe"
        );
        expect(gad.body.data.instrument.bands.map((b: { severity: string }) => b.severity)).not.toContain(
            "moderately-severe"
        );
    });

    it("bands an identical score differently per instrument", async () => {
        // 16 means "moderately severe depression" on PHQ-9 and "severe anxiety"
        // on GAD-7. A single hardcoded threshold would report one of them with
        // the wrong clinical word, and the patient reads it.
        const user = await createUser("patient");
        await sit(user, "phq9", 16, 0);
        await sit(user, "gad7", 16, 1);

        const phq = await get(user, "type=phq9");
        const gad = await get(user, "type=gad7");

        expect(phq.body.data.points[0].score).toBe(16);
        expect(phq.body.data.points[0].severity).toBe("moderately-severe");
        expect(gad.body.data.points[0].score).toBe(16);
        expect(gad.body.data.points[0].severity).toBe("severe");
    });

    it("requires an instrument, and refuses one it does not know", async () => {
        // `type` is required rather than optional precisely so a client cannot
        // ask for "everything" and plot two incompatible scales together.
        const user = await createUser("patient");

        const missing = await get(user, "limit=3");
        expect(missing.status).toBe(400);

        const unknown = await get(user, "type=mmpi");
        expect(unknown.status).toBe(400);
    });
});

describe("GET /api/wellness/assessments/trajectory - the series", () => {
    it("returns each point with its score, its band and its date, oldest first", async () => {
        const user = await createUser("patient");
        await sit(user, "phq9", 15, 0);
        await sit(user, "phq9", 11, 1);
        await sit(user, "phq9", 6, 2);

        const res = await get(user, "type=phq9");

        expect(res.status).toBe(200);
        expect(res.body.data.points.length).toBe(3);
        expect(res.body.data.points.map((p: { score: number }) => p.score)).toEqual([15, 11, 6]);
        // The severity is stored per submission and travels with the point, so
        // the chart cannot have to re-derive it and get an edge wrong.
        expect(res.body.data.points.map((p: { severity: string }) => p.severity)).toEqual([
            "moderately-severe",
            "moderate",
            "mild",
        ]);

        // Ordered by sitting date, ascending: a chart plots left-to-right in
        // time and a reversed series would read as a recovery.
        const times = res.body.data.points.map((p: { createdAt: string }) => new Date(p.createdAt).getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));

        // And the dates are the ones the sittings were actually submitted on.
        const stored = await prisma.assessment.findMany({
            where: { userId: user.id, type: "phq9" },
            orderBy: { createdAt: "asc" },
            select: { score: true, createdAt: true },
        });
        expect(res.body.data.points.map((p: { score: number }) => p.score)).toEqual(
            stored.map((r) => r.score)
        );
    });

    it("reports the change since the previous sitting, and none for the first", async () => {
        // Named rather than left as a signed number so a client cannot render a
        // falling score as a worsening one. Null on the first point because
        // there is no previous sitting to be different from.
        const user = await createUser("patient");
        await sit(user, "phq9", 15, 0);
        await sit(user, "phq9", 11, 1);
        await sit(user, "phq9", 6, 2);

        const res = await get(user, "type=phq9");

        expect(res.body.data.points.map((p: { changeFromPrevious: number | null }) => p.changeFromPrevious)).toEqual([
            null,
            -4,
            -5,
        ]);
    });

    it("returns an empty series for an instrument the patient has never taken", async () => {
        // "No data" is a normal state for a screening history, and the dashboard
        // renders an empty chart from it. A 404 would make the endpoint
        // indistinguishable from a broken one.
        const user = await createUser("patient");
        await sit(user, "phq9", 15, 0);
        await sit(user, "phq9", 11, 1);
        await sit(user, "phq9", 6, 2);

        const res = await get(user, "type=gad7");

        expect(res.status).toBe(200);
        expect(res.body.data.points).toEqual([]);
        expect(res.body.data.summary.sittings).toBe(0);
        expect(res.body.data.summary.first).toBeNull();
        expect(res.body.data.summary.latest).toBeNull();
        expect(res.body.data.summary.totalChange).toBeNull();
        // The instrument descriptor is still returned: the client needs the
        // axis range to draw an empty chart at all.
        expect(res.body.data.instrument.max).toBe(21);

        // Nothing was invented to fill it.
        const stored = await prisma.assessment.count({ where: { userId: user.id, type: "gad7" } });
        expect(stored).toBe(0);
    });
});

describe("GET /api/wellness/assessments/trajectory - the insufficient-data threshold", () => {
    // `wellness.service.ts` returns "insufficient-data" rather than "stable"
    // below three sittings, and says so: a regression here does not crash, it
    // silently inverts the clinical meaning. "Stable" is a claim that a person's
    // symptoms are not changing, and it must never be made from one measurement
    // or from the gap between two.

    it("reports no direction at all from a single sitting", async () => {
        const user = await createUser("patient");
        await sit(user, "phq9", 6, 0);

        const res = await get(user, "type=phq9");

        expect(res.body.data.summary.sittings).toBe(1);
        expect(res.body.data.summary.direction).toBe("insufficient-data");
        // The specific failure this guards: one sitting reported as "stable".
        expect(res.body.data.summary.direction).not.toBe("stable");
        expect(res.body.data.summary.direction).not.toBe("improving");
        expect(res.body.data.summary.direction).not.toBe("worsening");
    });

    it("refuses to call two sittings a trend, however large the change", async () => {
        // 20 -> 3 is a 17-point fall. The *number* is reported - the patient is
        // entitled to see it - but the service refuses to label it a recovery
        // from two measurements, because a two-point-window difference is inside
        // the noise of a self-report instrument.
        const user = await createUser("patient");
        await sit(user, "phq9", 20, 0);
        await sit(user, "phq9", 3, 1);

        const res = await get(user, "type=phq9");

        expect(res.body.data.summary.sittings).toBe(2);
        expect(res.body.data.summary.totalChange).toBe(-17);
        expect(res.body.data.summary.direction).toBe("insufficient-data");
        expect(res.body.data.summary.direction).not.toBe("improving");
    });

    it("reports a direction at exactly three sittings", async () => {
        // The boundary itself. Three sittings is the first count at which the
        // service is willing to characterise a change, so this is the case a
        // one-off change to `< 3` would break.
        const user = await createUser("patient");
        await sit(user, "phq9", 15, 0);
        await sit(user, "phq9", 11, 1);
        await sit(user, "phq9", 6, 2);

        const res = await get(user, "type=phq9");

        expect(res.body.data.summary.sittings).toBe(3);
        expect(res.body.data.summary.first).toBe(15);
        expect(res.body.data.summary.latest).toBe(6);
        expect(res.body.data.summary.totalChange).toBe(-9);
        expect(res.body.data.summary.direction).toBe("improving");
    });

    it("still reports a direction well above the threshold", async () => {
        // Above the threshold the answer is a real characterisation, and it
        // must not stay in the "cannot tell" state just because the early sittings
        // were unreadable.
        const user = await createUser("patient");
        await sit(user, "phq9", 20, 0);
        await sit(user, "phq9", 18, 1);
        await sit(user, "phq9", 16, 2);
        await sit(user, "phq9", 6, 3);
        await sit(user, "phq9", 4, 4);

        const res = await get(user, "type=phq9");

        expect(res.body.data.summary.sittings).toBe(5);
        expect(res.body.data.summary.totalChange).toBe(-16);
        expect(res.body.data.summary.direction).toBe("improving");
    });

    it("reports worsening when the score rises across three sittings", async () => {
        // The other direction, and the one that matters most: a rising screening
        // score is the signal the whole safety surface is built on.
        const user = await createUser("patient");
        await sit(user, "phq9", 3, 0);
        await sit(user, "phq9", 9, 1);
        await sit(user, "phq9", 14, 2);

        const res = await get(user, "type=phq9");

        expect(res.body.data.summary.totalChange).toBe(11);
        expect(res.body.data.summary.direction).toBe("worsening");
    });

    it("treats a three-point move as real and a two-point move as noise", async () => {
        // The edge of the change band, which is a different threshold from the
        // sitting count and just as easy to move by accident. Both cases have
        // three sittings, so only the total change differs.
        const mover = await createUser("patient");
        await sit(mover, "phq9", 8, 0);
        await sit(mover, "phq9", 6, 1);
        await sit(mover, "phq9", 5, 2);
        expect((await get(mover, "type=phq9")).body.data.summary.direction).toBe("improving");

        const quiet = await createUser("patient");
        await sit(quiet, "phq9", 8, 0);
        await sit(quiet, "phq9", 7, 1);
        await sit(quiet, "phq9", 6, 2);
        const res = await get(quiet, "type=phq9");
        expect(res.body.data.summary.sittings).toBe(3);
        expect(res.body.data.summary.totalChange).toBe(-2);
        expect(res.body.data.summary.direction).toBe("stable");
    });

    it("re-derives the latest point from the newest submission", async () => {
        // A later, higher sitting must move the headline: the summary is
        // computed from the rows, so a second submission is visible immediately
        // rather than the patient waiting for the next page load to see it.
        // The threshold is crossed mid-test as well, which is the whole point -
        // the same two sittings that were uncharacterisable become a worsening
        // trend the moment a third arrives.
        const user = await createUser("patient");
        await sit(user, "phq9", 3, 0);
        await sit(user, "phq9", 4, 1);

        const before = await get(user, "type=phq9");
        expect(before.body.data.summary.latest).toBe(4);
        expect(before.body.data.summary.direction).toBe("insufficient-data");

        await sit(user, "phq9", 21, 2);

        const after = await get(user, "type=phq9");
        expect(after.body.data.summary.sittings).toBe(3);
        expect(after.body.data.summary.latest).toBe(21);
        expect(after.body.data.summary.totalChange).toBe(18);
        expect(after.body.data.summary.direction).toBe("worsening");
        // The new score is re-banded, not carried over from the earlier one.
        expect(after.body.data.points[2].severity).toBe("severe");

        // And the earlier sittings are still on record: a new submission adds a
        // row rather than overwriting history.
        const stored = await prisma.assessment.findMany({
            where: { userId: user.id, type: "phq9" },
            orderBy: { createdAt: "asc" },
            select: { score: true, severity: true },
        });
        expect(stored).toEqual([
            { score: 3, severity: "minimal" },
            { score: 4, severity: "minimal" },
            { score: 21, severity: "severe" },
        ]);
    });
});

describe("GET /api/wellness/assessments/trajectory - the limit", () => {
    it("returns no more points than the limit asks for", async () => {
        const user = await createUser("patient");
        for (const [slot, score] of [2, 5, 8, 11, 14].entries()) {
            await sit(user, "phq9", score, slot);
        }

        const res = await get(user, "type=phq9&limit=3");

        expect(res.status).toBe(200);
        expect(res.body.data.points.length).toBe(3);
        // The count in the summary is derived from the page that was returned,
        // so the header and the chart cannot disagree.
        expect(res.body.data.summary.sittings).toBe(3);
    });

    it("takes the NEWEST sittings in the window, not the oldest", async () => {
        // A regression test for a real clinical bug, and the reason this file
        // exists in this shape.
        //
        // The query used to order ascending and then apply `take`, and MySQL
        // applies LIMIT *after* ORDER BY - so the window was the *beginning* of
        // the screening history. The five sittings below are stored as 2, 5, 8,
        // 11, 14, and a limit of 3 reported `latest: 8`.
        //
        // `summary.latest` is rendered as "Latest score" and `summary.direction`
        // as the improving / stable / worsening verdict, so once a patient's
        // history passed the window their headline score and their trend froze
        // at their earliest sittings and never moved again - while the raw
        // history on the same screen showed the real current score. A patient
        // whose PHQ-9 had risen sharply was shown a permanently improving
        // verdict.
        const user = await createUser("patient");
        for (const [slot, score] of [2, 5, 8, 11, 14].entries()) {
            await sit(user, "phq9", score, slot);
        }

        const res = await get(user, "type=phq9&limit=3");

        // The window is anchored to the present...
        expect(res.body.data.points.map((p: { score: number }) => p.score)).toEqual([8, 11, 14]);
        expect(res.body.data.summary.latest).toBe(14);
        // ...and the same window agrees with the full history, which is the
        // property that was broken: the headline must not disagree with the
        // most recent sitting.
        expect((await get(user, "type=phq9&limit=5")).body.data.summary.latest).toBe(14);
        // Still ascending, because `changeFromPrevious` is computed on the
        // series and a chart plots left-to-right in time. A reversed series
        // would read as a recovery when the opposite happened.
        const deltas = res.body.data.points.map((p: { changeFromPrevious: number | null }) =>
            p.changeFromPrevious
        );
        expect(deltas).toEqual([null, 3, 3]);
    });

    it("rejects a limit that would walk the whole screening history", async () => {
        // Bounded on both sides: a window of 1 cannot be a trajectory at all,
        // and an unbounded one would let the query pull a patient's whole
        // screening history a hundred sittings at a time.
        const user = await createUser("patient");

        expect((await get(user, "type=phq9&limit=1")).status).toBe(400);
        expect((await get(user, "type=phq9&limit=101")).status).toBe(400);
        expect((await get(user, "type=phq9&limit=0")).status).toBe(400);
        expect((await get(user, "type=phq9&limit=abc")).status).toBe(400);
        expect((await get(user, "type=phq9&limit=2.5")).status).toBe(400);
    });
});

describe("GET /api/wellness/assessments/trajectory - ownership", () => {
    it("returns only the caller's own screening history", async () => {
        // A screening history is clinical data. The route takes no patient id at
        // all - it reads `req.user.id` - so there is no parameter to get wrong
        // and no version of this endpoint that returns somebody else's.
        const userA = await createUser("patient");
        const userB = await createUser("patient");
        for (const [slot, score] of [4, 5, 4].entries()) await sit(userA, "phq9", score, slot);
        for (const [slot, score] of [20, 21, 20].entries()) await sit(userB, "phq9", score, slot);

        const a = await get(userA, "type=phq9");
        const b = await get(userB, "type=phq9");

        expect(a.body.data.points.map((p: { score: number }) => p.score)).toEqual([4, 5, 4]);
        expect(a.body.data.summary.latest).toBe(4);
        expect(b.body.data.points.map((p: { score: number }) => p.score)).toEqual([20, 21, 20]);
        expect(b.body.data.summary.latest).toBe(20);
    });

    it("ignores a patient id supplied in the query string", async () => {
        // Belt and braces on the same property. `userId` is not part of the
        // schema, so it is stripped rather than honoured - a caller naming
        // somebody else in the query gets their own history back, not an error
        // and not the other patient's.
        const owner = await createUser("patient");
        const other = await createUser("patient");
        for (const [slot, score] of [4, 5, 6].entries()) await sit(owner, "phq9", score, slot);
        for (const [slot, score] of [20, 21, 20].entries()) await sit(other, "phq9", score, slot);

        const res = await get(owner, `type=phq9&userId=${other.id}`);

        expect(res.status).toBe(200);
        expect(res.body.data.points.map((p: { score: number }) => p.score)).toEqual([4, 5, 6]);
    });

    it("does not let a clinician read a patient's trajectory through this route", async () => {
        // The dashboard route is the patient's own view. A doctor asking for a
        // patient's trajectory gets *their own* (empty) series, because the
        // scoping is `req.user.id` and not a parameter a doctor can name.
        // Clinician access to a patient's history is a separate, separately
        // authorised surface.
        const patient = await createUser("patient");
        const doctor = await createDoctor();
        for (const [slot, score] of [18, 19, 20].entries()) await sit(patient, "phq9", score, slot);

        const res = await doctor.agent.get(
            `/api/wellness/assessments/trajectory?type=phq9&userId=${patient.id}&patientId=${patient.id}`
        );

        expect(res.status).toBe(200);
        expect(res.body.data.points).toEqual([]);
        expect(res.body.data.summary.sittings).toBe(0);
    });

    it("refuses an anonymous caller outright", async () => {
        // The series is clinical data, so an unauthenticated read of it has to
        // be a 401 rather than an empty object that looks like "no history".
        const res = await request(app).get("/api/wellness/assessments/trajectory?type=phq9");

        expect(res.status).toBe(401);
    });
});
