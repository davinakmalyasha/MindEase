import { Router } from "express";
import { PaymentController } from "../controllers/payment.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { idParam } from "../schemas/params.schema";

const router = Router();

/**
 * Provider callback.
 *
 * Mounted before `authenticate` and before CSRF: the caller is a payment
 * gateway with no session cookie and no ability to echo a CSRF header, and
 * authenticity comes from the provider's own signature check instead. The raw
 * body it signs is preserved by the `verify` hook on the global JSON parser.
 */
router.post("/notification", PaymentController.notification);

router.use(authenticate);

router.get("/config", PaymentController.config);
router.get("/purchases", PaymentController.myPurchases);
router.get("/purchases/:id", validate(idParam), PaymentController.purchaseStatus);
router.post("/packages/:id/checkout", validate(idParam), PaymentController.checkout);

export default router;
