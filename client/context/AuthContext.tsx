"use client";

import {
    createContext,
    useContext,
    useEffect,
    useCallback,
    useMemo,
    useRef,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import api, { onSessionExpired } from "@/lib/api";

export interface AuthUser {
    id: string;
    email: string;
    name?: string;
    avatar?: string | null;
    role: "patient" | "doctor" | "admin";
    phone_number?: string | null;
    provider?: string;
    isVerified?: boolean;
    totpEnabled?: boolean;
    referralCode?: string | null;
    sessionCredits?: number;
    timezone?: string | null;
    doctorProfile?: { id: string; specialty?: string } | null;
}

export interface TwoFactorChallenge {
    requires2FA: true;
    twoFactorToken: string;
}

type LoginResult = AuthUser | TwoFactorChallenge;

interface AuthContextValue {
    user: AuthUser | null;
    /**
     * True until the stored session has been checked against the server.
     * Previously it flipped to false on mount without any request, so route
     * guards passed on stale `localStorage` and a user with a valid cookie but
     * an empty store saw an indefinite spinner.
     */
    isLoading: boolean;
    login: (email: string, password: string) => Promise<LoginResult>;
    loginWithGoogle: (idToken: string) => Promise<LoginResult>;
    complete2FA: (token: string, code: string) => Promise<AuthUser>;
    register: (data: {
        name: string;
        email: string;
        password: string;
        phone_number?: string;
        role?: string;
        referralCode?: string;
    }) => Promise<AuthUser>;
    logout: () => Promise<void>;
    refreshProfile: () => Promise<void>;
    setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "mindease:user";

/**
 * Paths that need a session, mirroring the matcher in `proxy.ts`.
 *
 * Used to decide whether a dead session warrants a redirect. The server-side
 * proxy already refuses these routes without a valid cookie; this is the
 * client's equivalent, and it is deliberately the *protected* list rather than a
 * list of public pages - a new protected page that someone forgets to add here
 * behaves as it did before, while a new public page is not accidentally treated
 * as needing a session.
 */
const PROTECTED_PREFIXES = ["/dashboard", "/messages", "/notifications"];

const readStoredUser = (): AuthUser | null => {
    if (typeof window === "undefined") return null;
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored ? (JSON.parse(stored) as AuthUser) : null;
    } catch {
        return null;
    }
};

const persistUser = (user: AuthUser | null) => {
    if (typeof window === "undefined") return;
    try {
        if (user) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
        else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Storage can be unavailable in private browsing or under a strict
        // cookie policy. The in-memory state is still authoritative.
    }
};

/**
 * The session store the provider reads through `useSyncExternalStore`.
 *
 * ## Why this is not `useState`
 *
 * It was `useState(readStoredUser)`, which seeds the user from `localStorage`
 * on the client and leaves it `null` on the server. The first client render
 * therefore disagreed with the server HTML on every page that branches on
 * `user` — the navbar's "My History" and "Messages" items, the dashboard
 * shell, a clinician's own reply controls — and React logged a hydration
 * mismatch and re-rendered the subtree on the client to recover. That is the
 * same mechanism that removed the login form's submit handler earlier in this
 * project, so it is not console noise. The e2e suite surfaced it in the navbar
 * on the first journey that rendered an authenticated page.
 *
 * `useSyncExternalStore` is React's API for exactly this: it renders with
 * `getServerSnapshot` while hydrating, so the first client render matches the
 * server HTML, and then re-renders with `getSnapshot` without a mismatch.
 *
 * ## The snapshots
 *
 * - `user`: `null` on the server, the parsed `localStorage` value on the
 *   client. Parsing is cached on the raw string's identity, so `getSnapshot`
 *   returns a stable object between renders, as React requires.
 * - `isLoading`: `true` on the server and during the hydration pass, and
 *   "a stored session exists but has not been validated yet" on the client.
 *   The server snapshot is deliberately `true` rather than `false`: the
 *   dashboard shell and any route guard branch on `(isLoading || !user)`, and a
 *   hydration pass that reports `false` while `user` is still `null` is the
 *   half-second that redirects a signed-in user to `/login`. There is no
 *   stored session on the server to be honest about, so "still loading" is the
 *   only server answer that cannot eject a real session.
 */
let cachedRaw: string | null | undefined;
let cachedUser: AuthUser | null = null;
let loadingState: boolean | undefined;
const storeListeners = new Set<() => void>();

const emitAuthStore = () => {
    for (const listener of storeListeners) listener();
};

const subscribeAuthStore = (listener: () => void) => {
    storeListeners.add(listener);
    return () => {
        storeListeners.delete(listener);
    };
};

const getUserSnapshot = (): AuthUser | null => {
    // A fresh `getItem` on every call is cheaper than a correctness bug: the
    // parse only reruns when the stored string actually changes, and it keeps
    // `localStorage` the single source of truth - including for anything that
    // writes it outside this module (another tab, a test).
    const raw = readRawUser();
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        // A corrupt value reads as "no session" rather than throwing inside a
        // render: the key is user-writable storage, and a crash loop on boot is
        // worse than a signed-out one.
        try {
            cachedUser = raw ? (JSON.parse(raw) as AuthUser) : null;
        } catch {
            cachedUser = null;
        }
    }
    return cachedUser;
};

const getLoadingSnapshot = (): boolean => {
    if (loadingState === undefined) loadingState = readStoredUser() !== null;
    return loadingState;
};

/** Stable identity, so React is not re-rendering because the function moved. */
const serverUserSnapshot = (): AuthUser | null => null;
/** See the store's comment: "still loading" is the only safe server answer. */
const serverLoadingSnapshot = (): boolean => true;

const setStoreUser = (next: AuthUser | null) => {
    persistUser(next);
    cachedRaw = undefined;
    emitAuthStore();
};

const setStoreLoading = (next: boolean) => {
    if (loadingState === next) return;
    loadingState = next;
    emitAuthStore();
};

/** The raw stored string, or `null`. Split out so the parse cache can watch it. */
function readRawUser(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

export function AuthProvider({ children }: { children: ReactNode }) {
    // Read through the external store rather than holding state, so the server
    // render, the hydration pass and the client all agree on who is signed in.
    // See the store's comment above: `useState(readStoredUser)` is a hydration
    // mismatch by construction, and the server snapshot for `isLoading` is
    // `true` so a route guard cannot redirect before the stored session has
    // been restored.
    const user = useSyncExternalStore(subscribeAuthStore, getUserSnapshot, serverUserSnapshot);
    const isLoading = useSyncExternalStore(subscribeAuthStore, getLoadingSnapshot, serverLoadingSnapshot);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const setUser = useCallback((next: AuthUser | null) => {
        setStoreUser(next);
    }, []);

    const refreshProfile = useCallback(async () => {
        try {
            const res = await api.get("/users/profile");
            const profile = res.data?.data?.user ?? res.data?.data;
            if (profile && mounted.current) {
                setStoreUser(profile as AuthUser);
            }
        } catch {
            // Not signed in, or the request was superseded. The stored value
            // remains until an explicit sign-out or an expired session.
        }
    }, []);

    // Validate the stored session against the server exactly once on mount.
    useEffect(() => {
        let cancelled = false;

        // Nothing to validate when this browser has never held a session.
        //
        // This ran unconditionally, and that made the entire public site
        // unreachable. A logged-out visitor loaded `/`, or `/register`, or a
        // clinician's profile; this fired `GET /users/profile`; the API answered
        // 401 because there was no session; the interceptor tried a refresh,
        // which failed for the same reason; and the failure was reported as a
        // *session expiry*, which redirects to `/login?expired=1`.
        //
        // So a first-time visitor was told their session had expired, and the
        // registration page could not be reached at all - the one page that
        // exists for people who do not yet have an account. The e2e journey that
        // registers a patient is what surfaced it, on the suite's first run.
        //
        // A stored user is the only thing there is to re-validate. Without one,
        // the answer is already known.
        if (!readStoredUser()) {
            // Even when there is nothing to validate, the loading flag is
            // corrected explicitly: a stale `true` (reachable across mounts)
            // would leave a guarded page on its spinner forever.
            setStoreLoading(false);
            return;
        }

        // A validation is in flight, so the flag is set before the request
        // rather than after it. The lazy initial value already covers the
        // ordinary mount; this covers the case where a previous mount left it
        // `false` while a session was still stored.
        setStoreLoading(true);

        (async () => {
            try {
                const res = await api.get("/users/profile");
                if (!cancelled && mounted.current) {
                    const profile = res.data?.data?.user ?? res.data?.data;
                    if (profile) {
                        setStoreUser(profile as AuthUser);
                    }
                }
            } catch {
                if (!cancelled && mounted.current) {
                    // No valid session: drop the cached user rather than
                    // leaving the UI in a half-authenticated state.
                    setStoreUser(null);
                }
            } finally {
                if (!cancelled && mounted.current) setStoreLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // The API client owns the "your session is gone" decision; the provider
    // owns the user-visible reaction to it.
    useEffect(() => {
        onSessionExpired(() => {
            setStoreUser(null);
            if (typeof window === "undefined") return;
            const { pathname, search } = window.location;

            // Only redirect away from somewhere that needed the session.
            //
            // This skipped `/login` and redirected from everywhere else, so a
            // session that died while someone was reading the home page, the
            // privacy notice or a clinician's public profile threw them at a
            // login screen captioned "your session expired". Being signed out is
            // not a reason to leave a page that never required being signed in.
            if (!PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
                return;
            }

            const next = encodeURIComponent(`${pathname}${search}`);
            window.location.href = `/login?next=${next}&expired=1`;
        });
        return () => onSessionExpired(null);
    }, []);

    const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
        const res = await api.post("/auth/login", { email, password });
        const data = res.data.data;
        if (data.requires2FA) {
            return { requires2FA: true, twoFactorToken: String(data.twoFactorToken) };
        }
        const loggedIn = data.user as AuthUser;
        setStoreUser(loggedIn);
        return loggedIn;
    }, []);

    const loginWithGoogle = useCallback(async (idToken: string): Promise<LoginResult> => {
        const res = await api.post("/auth/google", { token: idToken });
        const data = res.data.data;
        if (data.requires2FA) {
            return { requires2FA: true, twoFactorToken: String(data.twoFactorToken) };
        }
        const loggedIn = data.user as AuthUser;
        setStoreUser(loggedIn);
        return loggedIn;
    }, []);

    const complete2FA = useCallback(async (token: string, code: string) => {
        const res = await api.post("/account/2fa/verify", { token, code });
        const loggedIn = res.data.data.user as AuthUser;
        setStoreUser(loggedIn);
        return loggedIn;
    }, []);

    const register = useCallback(
        async (data: {
            name: string;
            email: string;
            password: string;
            phone_number?: string;
            role?: string;
            referralCode?: string;
        }) => {
            const res = await api.post("/auth/register", data);
            const registered = res.data.data.user as AuthUser;
            setStoreUser(registered);
            return registered;
        },
        []
    );

    const logout = useCallback(async () => {
        try {
            await api.post("/auth/logout");
        } catch {
            // The local session is cleared regardless: a failed server-side
            // logout must not leave the user apparently signed in.
        }
        setStoreUser(null);
    }, []);

    /**
     * A single memoized value. Previously a fresh object literal was created on
     * every render, so all 30-odd `useAuth()` consumers re-rendered on any
     * auth-state change — including on every notification poll.
     */
    const value = useMemo<AuthContextValue>(
        () => ({
            user,
            isLoading,
            login,
            loginWithGoogle,
            complete2FA,
            register,
            logout,
            refreshProfile,
            setUser,
        }),
        [user, isLoading, login, loginWithGoogle, complete2FA, register, logout, refreshProfile, setUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used within AuthProvider");
    return ctx;
}
