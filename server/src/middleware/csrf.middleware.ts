import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const COOKIE_NAME = "csrfToken";
const HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

// Issue a CSRF token (double-submit cookie pattern)
export const issueCsrfToken = (req: Request, res: Response) => {
    let token = req.cookies[COOKIE_NAME];
    if (!token) {
        token = crypto.randomBytes(32).toString("hex");
        res.cookie(COOKIE_NAME, token, {
            httpOnly: false, // readable by the client to echo back in headers
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
        });
    }
    return token;
};

export const csrfProtect = (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.includes(req.method)) {
        return next();
    }

    const cookieToken = req.cookies[COOKIE_NAME];
    const headerToken = req.headers[HEADER_NAME];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ status: "error", message: "Invalid CSRF token" });
    }
    next();
};

// Route to obtain the current token (also sets the cookie)
export const csrfTokenHandler = (req: Request, res: Response) => {
    const token = issueCsrfToken(req, res);
    res.json({ status: "success", data: { csrfToken: token } });
};
