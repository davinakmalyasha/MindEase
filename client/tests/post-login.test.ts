import { describe, it, expect } from "vitest";
import { isSafeInternalPath, resolvePostLoginPath } from "@/lib/postLogin";

/**
 * Post-login redirect safety.
 *
 * The bug: the check was `nextPath.startsWith("/")`, then
 * `window.location.href = target`. `//evil.example` starts with a slash and is a
 * protocol-relative URL, so `GET /login?next=//evil.example` served the real
 * login page, took real credentials, and then sent the authenticated user to the
 * attacker's origin — after the second factor, because the same function ran on
 * the 2FA path too.
 *
 * These cases are the exact strings an attacker would try, including the
 * backslash variants browsers normalise to a forward slash.
 */
describe("isSafeInternalPath", () => {
    it("accepts an ordinary internal path", () => {
        expect(isSafeInternalPath("/dashboard")).toBe(true);
        expect(isSafeInternalPath("/dashboard/assessments")).toBe(true);
        expect(isSafeInternalPath("/messages?with=12")).toBe(true);
        expect(isSafeInternalPath("/dashboard/care-plan#goals")).toBe(true);
    });

    it("rejects the protocol-relative form", () => {
        // The actual exploit.
        expect(isSafeInternalPath("//evil.example")).toBe(false);
        expect(isSafeInternalPath("//evil.example/path")).toBe(false);
    });

    it("rejects the backslash forms browsers normalise to a forward slash", () => {
        // `/\evil.example` is treated as `//evil.example` by Chrome and Firefox.
        expect(isSafeInternalPath("/\\evil.example")).toBe(false);
        expect(isSafeInternalPath("\\\\evil.example")).toBe(false);
    });

    it("rejects an absolute URL", () => {
        expect(isSafeInternalPath("https://evil.example")).toBe(false);
        expect(isSafeInternalPath("http://evil.example")).toBe(false);
        expect(isSafeInternalPath("HTTPS://EVIL.EXAMPLE")).toBe(false);
    });

    it("rejects other schemes", () => {
        // `javascript:` is the dangerous one; the rest are just not paths.
        expect(isSafeInternalPath("javascript:alert(1)")).toBe(false);
        expect(isSafeInternalPath("mailto:someone@example.com")).toBe(false);
        expect(isSafeInternalPath("data:text/html,<script>")).toBe(false);
    });

    it("rejects a relative path", () => {
        // No leading slash means it is relative to the current route, which is
        // not what a redirect parameter means and is not something to navigate to
        // explicitly.
        expect(isSafeInternalPath("dashboard")).toBe(false);
        expect(isSafeInternalPath("../dashboard")).toBe(false);
        expect(isSafeInternalPath("")).toBe(false);
    });

    it("rejects absent input", () => {
        expect(isSafeInternalPath(null)).toBe(false);
        expect(isSafeInternalPath(undefined)).toBe(false);
        expect(isSafeInternalPath("")).toBe(false);
    });
});

describe("resolvePostLoginPath", () => {
    it("uses a safe requested path", () => {
        expect(resolvePostLoginPath("/dashboard/assessments", "patient")).toBe(
            "/dashboard/assessments"
        );
    });

    it("falls back to a role-appropriate default for an unsafe path", () => {
        // This is the assertion that matters: the attacker-controlled value never
        // survives, for any role.
        expect(resolvePostLoginPath("//evil.example", "patient")).toBe("/dashboard/mood");
        expect(resolvePostLoginPath("//evil.example", "doctor")).toBe("/dashboard");
        expect(resolvePostLoginPath("//evil.example", "admin")).toBe("/dashboard/admin");
        expect(resolvePostLoginPath("/\\evil.example", "patient")).toBe("/dashboard/mood");
        expect(resolvePostLoginPath("https://evil.example", "doctor")).toBe("/dashboard");
    });

    it("falls back when no path was requested", () => {
        expect(resolvePostLoginPath(null, "patient")).toBe("/dashboard/mood");
        expect(resolvePostLoginPath(undefined, "doctor")).toBe("/dashboard");
        expect(resolvePostLoginPath("", "admin")).toBe("/dashboard/admin");
    });

    it("never returns an off-origin target, whatever it is given", () => {
        const hostile = [
            "//evil.example",
            "/\\evil.example",
            "\\\\evil.example",
            "https://evil.example",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "dashboard",
            "",
            null,
            undefined,
        ];
        for (const role of ["patient", "doctor", "admin"]) {
            for (const candidate of hostile) {
                const result = resolvePostLoginPath(candidate, role);
                expect(result, `${role} + ${String(candidate)}`).toMatch(/^\/(?!\/)/);
                expect(isSafeInternalPath(result)).toBe(true);
            }
        }
    });
});