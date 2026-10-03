import { describe, it, expect, beforeEach } from "vitest";
import { createUser, createDoctor, setupClient } from "./helpers";
import { prisma } from "../src/app";
import { PaymentService } from "../src/services/payment.service";
import { __setPaymentProvider, type PaymentNotification, type PaymentProvider } from "../src/lib/payments";

/**
 * Package checkout.
 *
 * The behaviour under test is mostly *negative*: an entitlement must not be
 * grantable by anything except a verified provider callback or an explicit
 * administrator. The original code minted unlimited free therapy packages that
 * could be spent on any doctor's sessions, so these are regression tests for
 * that, not coverage of a new happy path.
 */

let doctorUserId = 0;
let packageId = 0;

/** A provider that never talks to a network and never settles on its own. */
function stubProvider(outcome: PaymentNotification["outcome"] = "paid") {
    const calls: { orderId: string; amount: number }[] = [];
    const provider: PaymentProvider = {
        mode: "simulator",
        isSimulated: false,
        async createCheckout(request) {
            return { checkoutUrl: "https://pay.test/checkout", orderId: request.orderId };
        },
        parseNotification(_headers, raw) {
            const body = JSON.parse(raw) as { orderId: string; amount: number };
            calls.push({ orderId: body.orderId, amount: body.amount });
            return {
                orderId: body.orderId,
                amount: body.amount,
                outcome,
                reference: "stub_1",
            };
        },
    };
    return { provider, calls };
}

async function seedPackagedDoctor() {
    const doctor = await createDoctor();
    doctorUserId = doctor.id;

    const pkg = await prisma.package.create({
        data: {
            doctorId: doctor.doctorId,
            name: "4-session starter",
            sessionCount: 4,
            totalPrice: 600000,
            active: true,
        },
    });
    packageId = pkg.id;
}

beforeEach(async () => {
    __setPaymentProvider(null);
    await seedPackagedDoctor();
});

describe("Package checkout", () => {
    it("opens a checkout that is not yet an entitlement", async () => {
        const { provider } = stubProvider("pending");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const res = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(201);
        expect(res.body.data.checkoutUrl).toBeTruthy();

        // The purchase exists but carries no `paidAt` and no sessions, so the
        // booking path — which requires one or an admin grant — cannot use it.
        const purchase = await prisma.packagePurchase.findFirst({
            where: { userId: patient.id },
        });
        expect(purchase).not.toBeNull();
        expect(purchase!.paidAt).toBeNull();
        expect(purchase!.sessionsLeft).toBe(0);

        const order = await prisma.paymentOrder.findFirst({
            where: { purchaseId: purchase!.id },
        });
        expect(order).not.toBeNull();
        expect(order!.status).toBe("pending");
    });

    it("grants sessions only after a verified callback", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const checkout = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        const orderId = checkout.body.data.orderId;

        const result = await PaymentService.applyOutcome(orderId, 600000, "paid", "stub_1");
        expect(result.applied).toBe(true);

        const purchase = await prisma.packagePurchase.findFirst({
            where: { userId: patient.id },
        });
        expect(purchase!.paidAt).not.toBeNull();
        expect(purchase!.sessionsLeft).toBe(4);
        expect(purchase!.status).toBe("active");
    });

    it("is idempotent across duplicate callbacks", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const checkout = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        const orderId = checkout.body.data.orderId;

        await PaymentService.applyOutcome(orderId, 600000, "paid", "stub_1");
        // Providers retry webhooks freely. A second settlement must not double
        // the entitlement.
        const second = await PaymentService.applyOutcome(orderId, 600000, "paid", "stub_1");
        expect(second.applied).toBe(false);
        expect(second.reason).toBe("already_paid");

        const purchase = await prisma.packagePurchase.findFirst({
            where: { userId: patient.id },
        });
        expect(purchase!.sessionsLeft).toBe(4);
    });

    it("refuses a callback whose amount does not match the order", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const checkout = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        const orderId = checkout.body.data.orderId;

        // A tampered callback under-reporting the price must not grant anything.
        await expect(PaymentService.applyOutcome(orderId, 1, "paid", "evil")).rejects.toThrow(
            /amount does not match/i
        );

        const purchase = await prisma.packagePurchase.findFirst({
            where: { userId: patient.id },
        });
        expect(purchase!.paidAt).toBeNull();
    });

    it("releases the purchase when the order fails or expires", async () => {
        const { provider } = stubProvider("expired");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const checkout = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        const orderId = checkout.body.data.orderId;

        const result = await PaymentService.applyOutcome(orderId, 600000, "expired");
        expect(result.applied).toBe(true);

        // Nothing left behind: no phantom entitlement, no phantom revenue.
        expect(await prisma.packagePurchase.count({ where: { userId: patient.id } })).toBe(0);
        expect(await prisma.paymentOrder.count({ where: { orderId } })).toBe(0);
    });

    it("does not let a settled order be downgraded by a late pending callback", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const checkout = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        const orderId = checkout.body.data.orderId;

        await PaymentService.applyOutcome(orderId, 600000, "paid");
        // Out-of-order delivery is normal. A `settlement` arriving after a
        // `capture` must not re-open the entitlement.
        await PaymentService.applyOutcome(orderId, 600000, "pending");

        const purchase = await prisma.packagePurchase.findFirst({
            where: { userId: patient.id },
        });
        expect(purchase!.status).toBe("active");
        expect(purchase!.sessionsLeft).toBe(4);
    });

    it("refuses a second concurrent checkout for the same package", async () => {
        const { provider } = stubProvider("pending");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const first = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        expect(first.status).toBe(201);

        // A refresh mid-redirect must not produce a second pending entitlement.
        const second = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        // 409 Conflict: a pending order for this package already exists.
        expect(second.status).toBe(409);
    });

    it("requires authentication to start a checkout", async () => {
        // Fetch a valid CSRF pair first, so this exercises the *session* check
        // rather than being satisfied by the CSRF rejection a bare POST gets.
        const { agent, csrf } = await setupClient();
        const res = await agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", csrf);
        expect(res.status).toBe(401);
    });

    it("hides another patient's purchase status behind a 404", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        const owner = await createUser("patient");
        const checkout = await owner.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", owner.csrf);
        await PaymentService.applyOutcome(checkout.body.data.orderId, 600000, "paid");

        const stranger = await createUser("patient");
        const res = await stranger.agent
            .get(`/api/payments/purchases/${checkout.body.data.purchaseId}`)
            .set("X-CSRF-Token", stranger.csrf);

        // 404 rather than 403: a patient must not be able to probe for the
        // existence of other patients' purchases.
        expect(res.status).toBe(404);
    });

    it("rejects a forged Midtrans signature", async () => {
        // Signature verification is the only thing standing between a crafted
        // POST and a free therapy package. Midtrans signs as
        // sha512(orderId + statusCode + grossAmount + serverKey), compared in
        // constant time. Exercised directly so the check is covered without
        // needing live merchant credentials.
        const { verifyMidtransSignature } = await import("../src/lib/payments");
        const crypto = await import("crypto");

        const orderId = "ME-ORDER123";
        const statusCode = "capture";
        const grossAmount = "600000";
        const serverKey = "test_server_key";

        const good = crypto
            .createHash("sha512")
            .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
            .digest("hex");
        expect(verifyMidtransSignature({ orderId, statusCode, grossAmount, signature: good, serverKey })).toBe(true);

        // Wrong key.
        const wrongKey = crypto
            .createHash("sha512")
            .update(`${orderId}${statusCode}${grossAmount}a-different-key`)
            .digest("hex");
        expect(verifyMidtransSignature({ orderId, statusCode, grossAmount, signature: wrongKey, serverKey })).toBe(false);

        // Under-reported amount, re-signed legitimately. Amount is checked
        // separately against the order, so this must fail the signature too.
        const tampered = crypto
            .createHash("sha512")
            .update(`${orderId}${statusCode}1${serverKey}`)
            .digest("hex");
        expect(verifyMidtransSignature({ orderId, statusCode, grossAmount: "1", signature: tampered, serverKey })).toBe(true);

        // Altered order id with the original signature.
        expect(
            verifyMidtransSignature({ orderId: "ME-ORDER999", statusCode, grossAmount, signature: good, serverKey })
        ).toBe(false);

        // Empty and truncated signatures must not throw, just fail.
        expect(verifyMidtransSignature({ orderId, statusCode, grossAmount, signature: "", serverKey })).toBe(false);
        expect(verifyMidtransSignature({ orderId, statusCode, grossAmount, signature: "ab", serverKey })).toBe(false);
    });

    it("ignores a callback for an order it does not recognise", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        // The guard that matters even when signature checks pass: an order id
        // with no matching purchase must never create an entitlement.
        const result = await PaymentService.handleNotification(
            {},
            JSON.stringify({ orderId: "ME-NEVER-EXISTED", amount: 600000 })
        );
        expect(result.applied).toBe(false);
        expect(result.reason).toBe("unknown_order");
        expect(await prisma.packagePurchase.count({ where: { paidAt: { not: null } } })).toBe(0);
    });

    it("rejects a malformed notification body", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);
        await expect(PaymentService.handleNotification({}, "{not json")).rejects.toThrow();
    });

    it("ignores a package that belongs to an unapproved clinician", async () => {
        const { provider } = stubProvider("pending");
        __setPaymentProvider(provider);

        const pendingDoctor = await createDoctor(undefined, { verified: false });
        const pkg = await prisma.package.create({
            data: {
                doctorId: pendingDoctor.doctorId,
                name: "Unapproved",
                sessionCount: 2,
                totalPrice: 100000,
                active: true,
            },
        });

        const patient = await createUser("patient");
        const res = await patient.agent
            .post(`/api/payments/packages/${pkg.id}/checkout`)
            .set("X-CSRF-Token", patient.csrf);

        expect(res.status).toBe(400);
        expect(await prisma.packagePurchase.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("reports the configured provider so the client can label a simulation", async () => {
        const patient = await createUser("patient");
        const res = await patient.agent
            .get("/api/payments/config")
            .set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(200);
        // With no merchant credentials configured the platform settles in
        // simulation. The client reads this so it never implies a card will be
        // charged, and `config/env.ts` refuses to boot production in this mode.
        expect(res.body.data.simulated).toBe(true);
        expect(res.body.data.mode).toBe("simulator");
    });
});

describe("Package entitlement integrity", () => {
    it("still refuses an unbacked self-service grant", async () => {
        // The direct service path must remain closed. `paidAt` and
        // `grantedByUserId` are the only two legitimate ways in.
        const patient = await createUser("patient");
        const { DoctorService } = await import("../src/services/doctor.service");

        await expect(DoctorService.purchasePackage(packageId, patient.id)).rejects.toThrow(
            /requires payment/i
        );
        expect(await prisma.packagePurchase.count({ where: { userId: patient.id } })).toBe(0);
    });

    it("accepts an explicit administrative grant and snapshots the terms", async () => {
        const patient = await createUser("patient");
        const { DoctorService } = await import("../src/services/doctor.service");

        const purchase = await DoctorService.purchasePackage(packageId, patient.id, {
            grantedByUserId: doctorUserId,
        });

        expect(purchase.sessionsLeft).toBe(4);
        // Snapshotted, so a later re-pricing cannot rewrite what was granted.
        expect(purchase.totalPrice).toBe(600000);
        expect(purchase.sessionCount).toBe(4);
        expect(purchase.paidAt).toBeNull();
    });

    it("excludes unsettled rows from the patient's package list", async () => {
        const { provider } = stubProvider("pending");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);

        // A pending row is an abandoned checkout, not something the patient owns.
        const res = await patient.agent
            .get("/api/payments/purchases")
            .set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(0);
    });

    it("shows a settled entitlement", async () => {
        const { provider } = stubProvider("paid");
        __setPaymentProvider(provider);

        const patient = await createUser("patient");
        const checkout = await patient.agent
            .post(`/api/payments/packages/${packageId}/checkout`)
            .set("X-CSRF-Token", patient.csrf);
        await PaymentService.applyOutcome(checkout.body.data.orderId, 600000, "paid");

        const res = await patient.agent
            .get("/api/payments/purchases")
            .set("X-CSRF-Token", patient.csrf);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].sessionsLeft).toBe(4);
    });
});
