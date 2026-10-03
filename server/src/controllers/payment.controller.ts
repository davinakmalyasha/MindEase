import { Request, Response } from "express";
import { PaymentService } from "../services/payment.service";
import { getPaymentProvider } from "../lib/payments";
import { logger } from "../utils/logger";
import { publicMessageFor } from "../utils/appError";

export const PaymentController = {
    /**
     * `POST /api/payments/checkout`
     *
     * Opens a provider checkout for a therapy package. The purchase is created
     * pending and only becomes usable once a verified callback settles it.
     */
    async checkout(req: Request, res: Response) {
        const packageId = Number(req.params.id);
        if (!Number.isInteger(packageId) || packageId <= 0) {
            return res.status(400).json({ status: "error", message: "Invalid package id" });
        }
        try {
            const session = await PaymentService.createCheckout(packageId, req.user!.id);
            res.status(201).json({ status: "success", data: session });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Could not start checkout.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    },

    /**
     * `GET /api/payments/purchases`
     *
     * The caller's own entitlements. Replaces the `GET /api/packages/my` path the
     * client used to call, which was never mounted and 404'd silently.
     */
    async myPurchases(req: Request, res: Response) {
        try {
            const purchases = await PaymentService.getMyPurchases(req.user!.id);
            res.json({ status: "success", data: purchases });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch packages.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    },

    /** `GET /api/payments/purchases/:id` — status of one purchase. */
    async purchaseStatus(req: Request, res: Response) {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ status: "error", message: "Invalid purchase id" });
        }
        try {
            const status = await PaymentService.getStatus(id, req.user!.id);
            if (!status) {
                // 404 rather than 403: a patient should not be able to probe for
                // the existence of other patients' purchases.
                return res.status(404).json({ status: "error", message: "Purchase not found" });
            }
            res.json({ status: "success", data: status });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch purchase.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    },

    /**
     * `GET /api/payments/config`
     *
     * Tells the client which provider is live, so it can label a checkout as a
     * simulation rather than implying a real card will be charged.
     */
    config(_req: Request, res: Response) {
        const provider = getPaymentProvider();
        res.json({
            status: "success",
            data: { mode: provider.mode, simulated: provider.isSimulated },
        });
    },

    /**
     * `POST /api/payments/notification`
     *
     * Provider callback. Unauthenticated by necessity — the caller is the
     * gateway, not a signed-in patient — so authenticity comes entirely from the
     * provider's signature check inside `handleNotification`. An unverified
     * payload here would be a free-entitlement primitive, which is why the
     * controller only forwards the *raw* body and never touches the database.
     */
    async notification(req: Request, res: Response) {
        const raw = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
        try {
            const result = await PaymentService.handleNotification(req.headers as Record<string, string>, raw);
            // Always 200 on a well-formed notification, even when it was a
            // duplicate. Providers retry non-2xx aggressively, and a retry storm
            // on an already-settled order is pure noise.
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            logger.warn({ err: (error as Error)?.message }, "Rejected payment notification");
            res.status(400).json({ status: "error", message: "Invalid payment notification" });
        }
    },
};
