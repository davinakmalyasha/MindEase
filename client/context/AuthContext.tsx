"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    useMemo,
    useRef,
    type ReactNode,
} from "react";
import api, { onSessionExpired } from "@/lib/api";

export interface AuthUser {
    id: number;
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
    doctorProfile?: { id: number; specialty?: string } | null;
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

export function AuthProvider({ children }: { children: ReactNode }) {
    // Seed from storage so the first paint is not empty, but treat it as
    // unverified until the server confirms it.
    const [user, setUserState] = useState<AuthUser | null>(readStoredUser);
    const [isLoading, setIsLoading] = useState(true);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const setUser = useCallback((next: AuthUser | null) => {
        setUserState(next);
        persistUser(next);
    }, []);

    const refreshProfile = useCallback(async () => {
        try {
            const res = await api.get("/users/profile");
            const profile = res.data?.data?.user ?? res.data?.data;
            if (profile && mounted.current) {
                setUserState(profile as AuthUser);
                persistUser(profile as AuthUser);
            }
        } catch {
            // Not signed in, or the request was superseded. The stored value
            // remains until an explicit sign-out or an expired session.
        }
    }, []);

    // Validate the stored session against the server exactly once on mount.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await api.get("/users/profile");
                if (!cancelled && mounted.current) {
                    const profile = res.data?.data?.user ?? res.data?.data;
                    if (profile) {
                        setUserState(profile as AuthUser);
                        persistUser(profile as AuthUser);
                    }
                }
            } catch {
                if (!cancelled && mounted.current) {
                    // No valid session: drop the cached user rather than
                    // leaving the UI in a half-authenticated state.
                    setUserState(null);
                    persistUser(null);
                }
            } finally {
                if (!cancelled && mounted.current) setIsLoading(false);
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
            setUserState(null);
            persistUser(null);
            if (typeof window === "undefined") return;
            const { pathname, search } = window.location;
            if (pathname.startsWith("/login")) return;
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
        setUserState(loggedIn);
        persistUser(loggedIn);
        return loggedIn;
    }, []);

    const loginWithGoogle = useCallback(async (idToken: string): Promise<LoginResult> => {
        const res = await api.post("/auth/google", { token: idToken });
        const data = res.data.data;
        if (data.requires2FA) {
            return { requires2FA: true, twoFactorToken: String(data.twoFactorToken) };
        }
        const loggedIn = data.user as AuthUser;
        setUserState(loggedIn);
        persistUser(loggedIn);
        return loggedIn;
    }, []);

    const complete2FA = useCallback(async (token: string, code: string) => {
        const res = await api.post("/account/2fa/verify", { token, code });
        const loggedIn = res.data.data.user as AuthUser;
        setUserState(loggedIn);
        persistUser(loggedIn);
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
            setUserState(registered);
            persistUser(registered);
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
        setUserState(null);
        persistUser(null);
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

/**
 * Redirects to the login page when there is no session, preserving the current
 * route so the user returns to it.
 */
export function useRequireAuth(requiredRole?: "patient" | "doctor" | "admin") {
    const { user, isLoading } = useAuth();

    useEffect(() => {
        if (isLoading) return;
        if (!user) {
            if (typeof window !== "undefined") {
                const next = encodeURIComponent(
                    `${window.location.pathname}${window.location.search}`
                );
                window.location.href = `/login?next=${next}`;
            }
            return;
        }
        if (requiredRole && user.role !== requiredRole) {
            window.location.href = "/dashboard";
        }
    }, [isLoading, user, requiredRole]);

    return { user, isLoading };
}
