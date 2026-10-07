import { Request, Response } from "express";
import { signWsTicket, WS_TICKET_TTL_SECONDS } from "../lib/tokens";

/**
 * `POST /api/realtime/ticket`
 *
 * Issues a short-lived ticket a browser can pass to the WebSocket service as
 * `?token=`. Reaching this endpoint requires a valid session cookie, and the
 * `authenticate` middleware has already re-checked the account against the
 * database, so a banned user or a session that has not completed two-factor
 * verification cannot obtain one.
 *
 * This exists because a browser cannot set headers on a WebSocket handshake and
 * the `accessToken` cookie is host-only for the API origin.
 */
export const RealtimeController = {
    ticket(req: Request, res: Response) {
        const user = req.user;
        if (!user) {
            return res.status(401).json({ status: "error", message: "Unauthorized" });
        }

        return res.json({
            status: "success",
            data: {
                ticket: signWsTicket(user),
                expiresIn: WS_TICKET_TTL_SECONDS,
            },
        });
    },
};
