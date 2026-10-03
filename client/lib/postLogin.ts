/**
 * Where to send a user after they authenticate.
 *
 * ## The bug this exists to fix
 *
 * The previous check was `nextPath && nextPath.startsWith("/")`, followed by
 * `window.location.href = target`. `//evil.example` and `/\evil.example` both
 * start with a slash, and both are protocol-relative URLs - the browser resolves
 * `//host` as `https://host`. So `GET /login?next=//evil.example` served the
 * genuine MindEase login page, collected real credentials, and then navigated
 * the freshly authenticated user to an attacker's origin.
 *
 * That is a phishing link that passes every check a user or a reviewer would
 * make: correct domain in the address bar until the moment of redirect, and the
 * credentials went to the real API. The same function also runs on the 2FA
 * completion path, so the bounce happened *after* the second factor - at the
 * point of maximum trust.
 *
 * ## Why the check is a function rather than an inline `!startsWith("//")`
 *
 * Because this is the kind of thing that gets refactored. A single regex
 * `startsWith` is invisible in review; a named function with a doc comment and a
 * test is not.
 */

/** Characters that let a path break out of its origin. */
const UNSAFE_PREFIXES = ["//", "/\\", "\\\\"];

/**
 * True when `path` is a same-origin, client-side navigation.
 *
 * Rejects anything that is not absolute-path-shaped, and anything using the
 * backslash forms browsers normalise to a forward slash. `new URL()` is the
 * authority on what actually resolves, so it gets the final say rather than the
 * prefix list being trusted on its own.
 */
export const isSafeInternalPath = (path: string | null | undefined): boolean => {
    if (!path) return false;
    if (UNSAFE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
    // A scheme or a host, e.g. `https://evil.example` or `mailto:someone`.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
    if (!path.startsWith("/")) return false;

    // Belt and braces: ask the platform what this resolves to. `//evil` and
    // `/\evil` would both come back with a different origin here, which is the
    // property that actually matters and the one a prefix check is guessing at.
    try {
        const base = new URL("http://localhost");
        const resolved = new URL(path, base);
        return resolved.origin === base.origin;
    } catch {
        return false;
    }
};

/**
 * The post-login destination: the requested path when it is safe, otherwise a
 * role-appropriate default.
 */
export const resolvePostLoginPath = (
    nextPath: string | null | undefined,
    role: string
): string => {
    if (isSafeInternalPath(nextPath)) return nextPath as string;
    if (role === "patient") return "/dashboard/mood";
    if (role === "doctor") return "/dashboard";
    return "/dashboard/admin";
};