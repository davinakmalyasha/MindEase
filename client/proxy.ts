import { NextResponse, NextRequest } from "next/server";
import { jwtVerify } from "jose";

// The dev fallback mirrors server/src/config/env.ts and must never be used in
// production: Vercel projects must set JWT_SECRET (same value as the API).
const secret = new TextEncoder().encode(
    process.env.NODE_ENV === "production"
        ? (process.env.JWT_SECRET ?? "")
        : process.env.JWT_SECRET || "dev_only_insecure_jwt_secret_change_me"
);

const PUBLIC_AFTER_LOGIN: Record<string, string[]> = {
    "/dashboard/doctor": ["doctor"],
    "/dashboard/admin": ["admin"],
    "/dashboard/mood": ["patient"],
    "/dashboard/briefing": ["doctor"],
    "/dashboard/pre-session": ["patient"],
};

export async function proxy(req: NextRequest) {
    const { pathname } = req.nextUrl;
    const token = req.cookies.get("accessToken")?.value;

    let role = "";
    if (token) {
        try {
            const { payload } = await jwtVerify(token, secret);
            role = (payload.role as string) || "";
        } catch {
            // Invalid/expired — treated as logged out; the API enforces real auth
        }
    }

    const isLoggedIn = Boolean(token && role);

    if (!isLoggedIn) {
        const login = new URL("/login", req.url);
        login.searchParams.set("next", pathname);
        return NextResponse.redirect(login);
    }

    // Role-based guards (best-effort UX layer; API enforces authorization)
    for (const [prefix, roles] of Object.entries(PUBLIC_AFTER_LOGIN)) {
        if (pathname.startsWith(prefix) && !roles.includes(role)) {
            return NextResponse.redirect(new URL("/dashboard", req.url));
        }
    }

    return NextResponse.next();
}

export const config = {
    matcher: ["/dashboard/:path*", "/messages", "/notifications"],
};
