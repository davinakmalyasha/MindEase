import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { getPaymentProvider, type PaymentOutcome } from "../lib/payments";
import { DoctorService } from "./doctor.service";
import { NotificationService } from "./notification.service";
import { logger } from "../utils/logger";
import { badRequest, conflict, notFound } from "../utils/appError";

/**
 * Therapy-package checkout.
 *
 * The invariant this file exists to protect: **`PackagePurchase.paidAt` is only
 * ever written here, from a verified provider callback, or by an administrator
 * acting deliberately.** `DoctorService.purchasePackage` refuses any grant with
 * neither `paidAt` nor `grantedByUserId`, so nothing else in the codebase can
 * manufacture an entitlement. That closed a real exploit — the original code
 * minted unlimited free packages that could be spent on any doctor's sessions.
 *
 * A purchase is created *pending*, with a provider order reference in the order
 * id, and only becomes usable when settlement is confirmed. Webhooks are
 * idempotent and monotonic: a duplicate callback is a no-op, and a `pending`
 * status can never downgrade an already-`paid` one.
 */
export class PaymentService {
    /**
     * Opens a checkout for a package.
     *
     * The purchase row is created first so the order reference is durable before
     * the patient is redirected. If the provider call fails the row is removed,
     * so a failed attempt does not leave a phantom entitlement behind — it has no
     * `paidAt`, so it could never be used, but it would clutter the patient's
     * package list and the clinic's revenue figures.
     */
    static async createCheckout(pkgId: number, userId: number) {
        const provider = getPaymentProvider();

        const pkg = await prisma.package.findFirst({
            where: { id: pkgId, active: true },
            include: {
                doctor: {
                    select: {
                        verificationStatus: true,
                        userId: true,
                        // A clinician's display name lives on the user row, not
                        // on the doctor profile.
                        user: { select: { name: true } },
                    },
                },
            },
        });
        if (!pkg) throw notFound("Package not found or inactive");
        if (pkg.doctor.verificationStatus !== "approved") {
            throw badRequest("This package is not currently available");
        }
        const doctorName = pkg.doctor.user.name ?? "your psychologist";

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, email: true },
        });
        if (!user) throw notFound("User not found");

        // One live checkout per (user, package). Without this a double click, or
        // a refresh mid-redirect, produced a second pending row and — once one
        // settled — two entitlements for one payment.
        //
        // Keyed on `status: "pending"` rather than on `sessionsLeft`: a pending
        // purchase deliberately starts at zero sessions so it cannot be booked
        // before settlement, which means a `sessionsLeft > 0` test never
        // matches the very rows this guard exists to find.
        const existing = await prisma.packagePurchase.findFirst({
            where: { userId, packageId: pkg.id, status: "pending", paidAt: null },
        });
        if (existing) {
            throw conflict("You already have a pending purchase for this package");
        }

        const orderId = `ME-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

        const pending = await prisma.packagePurchase.create({
            data: {
                packageId: pkg.id,
                userId,
                sessionsLeft: 0,
                // Starts unusable. `paidAt` is null and `sessionsLeft` is zero, so
                // the booking path — which requires one or the other — cannot
                // consume it before settlement.
                status: "pending",
                totalPrice: pkg.totalPrice,
                sessionCount: pkg.sessionCount,
            },
            select: { id: true },
        });

        // The provider is told this order id before the redirect, and it comes
        // back on the callback. Persist the mapping first so a callback that
        // arrives immediately still resolves.
        await prisma.paymentOrder.create({
            data: {
                orderId,
                purchaseId: pending.id,
                amount: pkg.totalPrice,
                currency: "IDR",
                simulated: provider.isSimulated,
            },
        });

        try {
            const session = await provider.createCheckout({
                orderId,
                amount: pkg.totalPrice,
                currency: "IDR",
                lines: [
                    {
                        id: String(pkg.id),
                        name: `${pkg.sessionCount}-session package with ${doctorName}`,
                        price: pkg.totalPrice,
                        quantity: 1,
                    },
                ],
                customer: { id: user.id, name: user.name ?? "Patient", email: user.email },
                successUrl: `${process.env.FRONTEND_URL || "http://localhost:3000"}/dashboard/profile?purchase=${pending.id}`,
                failureUrl: `${process.env.FRONTEND_URL || "http://localhost:3000"}/dashboard/profile?purchase=failed`,
            });

            if (provider.isSimulated) {
                // There is no upstream to redirect to, so settlement is applied
                // immediately. The purchase is otherwise indistinguishable from a
                // real one: same row, same `paidAt`, same entitlement.
                await this.applyOutcome(orderId, pkg.totalPrice, "paid", `sim_${orderId}`);
            }

            return {
                checkoutUrl: session.checkoutUrl,
                orderId,
                purchaseId: pending.id,
                simulated: provider.isSimulated,
            };
        } catch (error) {
            // A failed checkout is not an entitlement and not revenue. Remove the
            // rows so the patient does not see a phantom package and the clinic
            // does not report a sale that never started.
            await prisma.paymentOrder
                .deleteMany({ where: { purchaseId: pending.id } })
                .catch(() => null);
            await prisma.packagePurchase
                .delete({ where: { id: pending.id } })
                .catch(() => null);
            throw error;
        }
    }

    /**
     * Handles a provider callback.
     *
     * Idempotent and monotonic. A provider retries webhooks freely, and an
     * out-of-order `pending` after a `capture` must not re-open a settled
     * entitlement or double-credit the sessions.
     */
    static async applyOutcome(
        orderId: string,
        amount: number,
        outcome: PaymentOutcome,
        reference?: string
    ) {
        const order = await prisma.paymentOrder.findUnique({
            where: { orderId },
            include: { purchase: true },
        });
        const purchase = order?.purchase ?? (await prisma.packagePurchase.findFirst({ where: { reference: orderId } }));

        if (!purchase) {
            logger.warn({ orderId }, "Payment callback for an unknown order");
            return { applied: false, reason: "unknown_order" as const };
        }

        if (purchase.paidAt) {
            // Already settled. A repeat callback is not an error, but it must
            // not grant a second set of sessions.
            return { applied: false, reason: "already_paid" as const };
        }

        if (outcome !== "paid") {
            if (outcome === "pending") {
                // `settlement` maps here. Marking the order keeps a reconciliation
                // job able to tell "authorised, not captured" from "unknown".
                if (order) {
                    await prisma.paymentOrder
                        .update({ where: { orderId }, data: { status: "pending" } })
                        .catch(() => null);
                }
                return { applied: false, reason: "still_pending" as const };
            }
            // Failed, cancelled or expired: release the rows entirely so they do
            // not sit in the patient's package list or the revenue figures.
            if (order) {
                await prisma.paymentOrder
                    .update({ where: { orderId }, data: { status: outcome } })
                    .catch(() => null);
                await prisma.paymentOrder
                    .delete({ where: { orderId } })
                    .catch(() => null);
            }
            await prisma.packagePurchase.delete({ where: { id: purchase.id } }).catch(() => null);
            return { applied: true, reason: "released" as const };
        }

        // The provider is the authority on the amount, but the *order* is the
        // authority on what was sold. Re-checking here means a tampered callback
        // cannot under-report a purchase and still be accepted.
        const expected = order ? order.amount : purchase.totalPrice;
        if (amount !== expected) {
            logger.error(
                { orderId, expected, received: amount },
                "Payment amount mismatch; refusing to grant an entitlement"
            );
            throw badRequest("Payment amount does not match the order");
        }

        const [updated] = await prisma.$transaction([
            prisma.packagePurchase.update({
                where: { id: purchase.id },
                data: {
                    paidAt: new Date(),
                    status: "active",
                    sessionsLeft: purchase.sessionCount,
                    reference: reference ?? null,
                },
            }),
            order
                ? prisma.paymentOrder.update({
                      where: { orderId },
                      data: { status: "paid", settledAt: new Date(), reference: reference ?? null },
                  })
                : prisma.paymentOrder.deleteMany({ where: { orderId } }),
        ]);

        await NotificationService.create({
            userId: purchase.userId,
            title: "Your sessions are ready",
            message: `Your ${purchase.sessionCount}-session package has been confirmed. You can now book with your psychologist.`,
            type: "appointment",
            email: true,
        }).catch(() => null);

        return { applied: true, reason: "settled" as const, purchaseId: updated.id };
    }

    /**
     * Verifies and applies a provider callback.
     *
     * The provider parses *and authenticates* the payload; this method is the
     * only path from an inbound HTTP request to a `paidAt` write.
     */
    static async handleNotification(
        headers: Record<string, string | string[] | undefined>,
        rawBody: string
    ) {
        const provider = getPaymentProvider();
        const notification = provider.parseNotification(headers, rawBody);
        return this.applyOutcome(
            notification.orderId,
            notification.amount,
            notification.outcome,
            notification.reference
        );
    }

    static async getStatus(purchaseId: number, userId: number) {
        const purchase = await prisma.packagePurchase.findFirst({
            where: { id: purchaseId, userId },
            include: {
                package: { include: { doctor: { select: { user: { select: { name: true } } } } } },
            },
        });
        if (!purchase) return null;
        return {
            id: purchase.id,
            status: purchase.paidAt ? "paid" : purchase.status,
            sessionsLeft: purchase.sessionsLeft,
            sessionCount: purchase.sessionCount,
            totalPrice: purchase.totalPrice,
            paidAt: purchase.paidAt,
            doctor: purchase.package.doctor.user.name ?? "your psychologist",
        };
    }

    /**
     * Lists a patient's purchases, hiding rows that never settled.
     *
     * A `pending` row is an abandoned checkout, not something the patient owns.
     */
    static async getMyPurchases(userId: number) {
        return prisma.packagePurchase.findMany({
            where: { userId, sessionsLeft: { gt: 0 } },
            // `include: { doctor: true }` returned every Doctor scalar, so a
            // paying patient could read their clinician's bankAccount, bankName
            // and bankHolder from one authenticated call. Same class as the
            // directory leak and the appointments leak, and same fix: an
            // explicit allowlist rather than a bare include.
            include: {
                package: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        sessionCount: true,
                        totalPrice: true,
                        doctor: {
                            select: {
                                id: true,
                                specialty: true,
                                rating: true,
                                price: true,
                                user: { select: { name: true, avatar: true } },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
    }
}

/**
 * Grants a package on a clinician's or admin's behalf, e.g. a comped session.
 * Deliberately separate from checkout: it never fabricates a payment.
 */
export const grantPackage = DoctorService.purchasePackage;
