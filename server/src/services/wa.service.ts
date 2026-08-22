import { logger } from "../utils/logger";

/**
 * WhatsApp gateway abstraction (Fonnte-style HTTP API).
 * Configure via WA_GATEWAY_URL and WA_GATEWAY_TOKEN (Bearer token).
 * Gracefully no-ops when unconfigured, mirroring the mailer's dev fallback.
 */

const IS_PROD = process.env.NODE_ENV === "production";

export const isWhatsAppConfigured = () =>
    Boolean(process.env.WA_GATEWAY_URL && process.env.WA_GATEWAY_TOKEN);

const normalizePhone = (phone: string) => {
    const digits = phone.replace(/\D/g, "");
    if (digits.startsWith("0")) return "62" + digits.slice(1);
    if (digits.startsWith("8")) return "62" + digits;
    return digits;
};

export const WhatsAppService = {
    async send(to: string, message: string): Promise<boolean> {
        const url = process.env.WA_GATEWAY_URL;
        const token = process.env.WA_GATEWAY_TOKEN;
        if (!url || !token) {
            if (!IS_PROD) {
                console.log(`\n[WA:${to}] ${message}\n`);
            }
            return false;
        }

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ target: normalizePhone(to), message }),
            });
            if (!res.ok) {
                logger.warn({ status: res.status }, "WhatsApp gateway returned an error");
                return false;
            }
            return true;
        } catch (err: any) {
            logger.warn({ err: err.message }, "WhatsApp gateway unreachable");
            return false;
        }
    },
};
