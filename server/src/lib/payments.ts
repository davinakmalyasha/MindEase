/**
 * Payment provider abstraction.
 *
 * MindEase takes money for therapy packages. The provider is deliberately behind
 * an interface so that a deployment can be configured with a real merchant
 * account while a fresh clone still runs end to end: with no credentials the
 * platform selects an in-process simulator, exactly as it already does for SMTP,
 * web push and S3.
 *
 * The one rule the rest of the system depends on: **nothing outside a verified
 * provider callback may set `PackagePurchase.paidAt`.** That column is the sole
 * signal that an entitlement is legitimate, and `DoctorService.purchasePackage`
 * refuses any grant that has neither `paidAt` nor an explicit administrator.
 *
 * A simulator is refused in production by `config/env.ts`, so a misconfigured
 * deployment fails at boot rather than silently granting free therapy or
 * pretending a payment succeeded.
 */

import crypto from "crypto";
import { env } from "../config/env";

export type PaymentMode = "midtrans" | "simulator";

export interface CheckoutLine {
    id: string;
    name: string;
    price: number;
    quantity: number;
}

export interface CheckoutRequest {
    /** Stable, unique reference echoed back on the provider callback. */
    orderId: string;
    amount: number;
    currency?: string;
    lines: CheckoutLine[];
    customer: {
        id: number;
        name: string;
        email: string;
    };
    /** Where the provider returns the patient after payment. */
    successUrl: string;
    failureUrl: string;
}

export interface CheckoutSession {
    /** URL the patient is redirected to in order to pay. */
    checkoutUrl: string;
    orderId: string;
    /** Provider-specific token, retained for reconciliation. */
    token?: string;
}

export type PaymentOutcome = "paid" | "pending" | "failed" | "expired";

export interface PaymentNotification {
    orderId: string;
    outcome: PaymentOutcome;
    amount: number;
    /** Provider reference (transaction id, charge id). */
    reference?: string;
}

export interface PaymentProvider {
    readonly mode: PaymentMode;
    /** True when this provider settles in simulation rather than real money. */
    readonly isSimulated: boolean;
    createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
    /**
     * Verify and interpret a provider callback. Must throw when the payload is
     * not authentic — an unverified callback is a free-entitlement primitive.
     */
    parseNotification(
        headers: Record<string, string | string[] | undefined>,
        rawBody: string
    ): PaymentNotification;
}

/* ------------------------------------------------------------------ *
 * Midtrans Snap
 * ------------------------------------------------------------------ */

/**
 * Midtrans transaction status codes, collapsed onto our four outcomes.
 *
 * `settlement` is treated as pending, not paid: funds are only guaranteed on
 * `capture` or an explicit `settlement` webhook, and granting an entitlement on
 * a still-refundable authorisation is how a clinic ends up serving sessions it
 * was never paid for.
 */
const MIDTRANS_OUTCOMES: Record<string, PaymentOutcome> = {
    settlement: "pending",
    capture: "paid",
    pending: "pending",
    deny: "failed",
    cancel: "failed",
    expire: "expired",
    failure: "failed",
    refund: "expired",
    "partial-refund": "pending",
    reversal: "failed",
};

/**
 * Verifies a Midtrans notification signature.
 *
 * Midtrans signs as `sha512(orderId + statusCode + grossAmount + serverKey)`.
 * Exported as a pure function so the check can be tested without merchant
 * credentials — it is the single thing standing between a forged HTTP POST and a
 * free therapy package, and an untestable branch is not a defence.
 *
 * Comparison is timing-safe: `===` on hex digests leaks how many leading
 * characters matched.
 */
export const verifyMidtransSignature = (params: {
    orderId: string;
    statusCode: string;
    grossAmount: string;
    signature: string;
    serverKey: string;
}): boolean => {
    const expected = crypto
        .createHash("sha512")
        .update(`${params.orderId}${params.statusCode}${params.grossAmount}${params.serverKey}`)
        .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(params.signature, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

class MidtransProvider implements PaymentProvider {
    readonly mode = "midtrans" as const;
    readonly isSimulated = false;

    constructor(
        private readonly serverKey: string,
        private readonly baseUrl: string
    ) {}

    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
        const body = {
            transaction_details: {
                order_id: request.orderId,
                gross_amount: request.amount,
            },
            item_details: request.lines,
            customer_details: {
                first_name: request.customer.name,
                email: request.customer.email,
            },
            custom_expiry: { unit: "hour", expiry_duration: 24 },
            callbacks: { finish: request.successUrl },
        };

        const response = await fetch(`${this.baseUrl}/snap/v1/transactions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Basic ${Buffer.from(`${this.serverKey}:`).toString("base64")}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`Payment provider rejected the checkout (${response.status}): ${detail}`);
        }

        const payload = (await response.json()) as {
            token?: string;
            redirect_url?: string;
        };

        if (!payload.redirect_url || !payload.token) {
            throw new Error("Payment provider returned an incomplete checkout session");
        }

        return { checkoutUrl: payload.redirect_url, orderId: request.orderId, token: payload.token };
    }

    /**
     * Midtrans signs a notification as
     * `sha512(order_id + status_code + gross_amount + serverKey)`. Comparing it
     * with a timing-safe equality is what stops an attacker from POSTing a
     * fabricated "capture" callback and minting a free package.
     */
    parseNotification(
        _headers: Record<string, string | string[] | undefined>,
        rawBody: string
    ): PaymentNotification {
        let payload: Record<string, string>;
        try {
            payload = JSON.parse(rawBody) as Record<string, string>;
        } catch {
            throw new Error("Malformed payment notification");
        }

        const orderId = payload.order_id;
        const statusCode = payload.transaction_status;
        const grossAmount = payload.gross_amount;
        const signature = payload.signature_key;

        if (!orderId || !statusCode || !grossAmount || !signature) {
            throw new Error("Payment notification is missing required fields");
        }

        if (!verifyMidtransSignature({ orderId, statusCode, grossAmount, signature, serverKey: this.serverKey })) {
            throw new Error("Payment notification signature is invalid");
        }

        const outcome = MIDTRANS_OUTCOMES[statusCode];
        if (!outcome) {
            throw new Error(`Unknown payment transaction status "${statusCode}"`);
        }

        return {
            orderId,
            outcome,
            amount: Math.round(Number(grossAmount)),
            reference: payload.transaction_id,
        };
    }
}

/* ------------------------------------------------------------------ *
 * Simulator
 * ------------------------------------------------------------------ */

class SimulatorProvider implements PaymentProvider {
    readonly mode = "simulator" as const;
    readonly isSimulated = true;

    /**
     * A deterministic, obviously-fake URL. It never leaves the process: there is
     * no upstream to receive the redirect, so `PaymentService` marks the purchase
     * as settled immediately instead of pretending a round trip happened.
     */
    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
        return {
            checkoutUrl: `${request.successUrl}${request.successUrl.includes("?") ? "&" : "?"}sim=1&order=${encodeURIComponent(
                request.orderId
            )}`,
            orderId: request.orderId,
            token: `sim_${request.orderId}`,
        };
    }

    parseNotification(_headers: Record<string, string | string[] | undefined>, rawBody: string): PaymentNotification {
        let payload: { orderId?: string; outcome?: string; amount?: number };
        try {
            payload = JSON.parse(rawBody);
        } catch {
            throw new Error("Malformed simulated payment notification");
        }
        if (!payload.orderId || !payload.amount) {
            throw new Error("Simulated payment notification is missing required fields");
        }
        const outcome = payload.outcome ?? "paid";
        if (!["paid", "pending", "failed", "expired"].includes(outcome)) {
            throw new Error(`Unknown simulated outcome "${outcome}"`);
        }
        return {
            orderId: payload.orderId,
            outcome: outcome as PaymentOutcome,
            amount: Math.round(payload.amount),
            reference: `sim_${payload.orderId}`,
        };
    }
}

let cached: PaymentProvider | null = null;

export const getPaymentProvider = (): PaymentProvider => {
    if (cached) return cached;
    cached =
        env.payments.mode === "midtrans"
            ? new MidtransProvider(env.payments.serverKey, env.payments.baseUrl)
            : new SimulatorProvider();
    return cached;
};

/** Test seam — lets a suite install a double without touching the environment. */
export const __setPaymentProvider = (provider: PaymentProvider | null) => {
    cached = provider;
};
