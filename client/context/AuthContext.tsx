"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { useRouter } from "next/navigation";
import api from "@/lib/api";

export interface AuthUser {
    id: number;
    email: string;
    name?: string;
    avatar?: string | null;
    role: "patient" | "doctor" | "admin";
    phone_number?: string | null;
    provider?: string;
    [key: string]: any;
}

interface AuthContextValue {
    user: AuthUser | null;
    isLoading: boolean;
    login: (email: string, password: string) => Promise<AuthUser | { requires2FA: true; twoFactorToken: string }>;
    loginWithGoogle: (idToken: string) => Promise<AuthUser | { requires2FA: true; twoFactorToken: string }>;
    complete2FA: (token: string, code: string) => Promise<AuthUser>;
    register: (data: { name: string; email: string; password: string; phone_number?: string; role?: string; referralCode?: string }) => Promise<AuthUser>;
    logout: () => Promise<void>;
    refreshProfile: () => Promise<void>;
    setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredUser = (): AuthUser | null => {
    if (typeof window === "undefined") return null;
    try {
        const stored = localStorage.getItem("user");
        return stored ? JSON.parse(stored) : null;
    } catch {
        return null;
    }
};

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(readStoredUser);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsLoading(false);
    }, []);

    const refreshProfile = useCallback(async () => {
        try {
            const res = await api.get("/users/profile");
            const profile = res.data?.data?.user ?? res.data?.data;
            if (profile) {
                setUser(profile);
                localStorage.setItem("user", JSON.stringify(profile));
            }
        } catch {
            // Not logged in — ignore
        }
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const res = await api.post("/auth/login", { email, password });
        const data = res.data.data;
        if (data.requires2FA) {
            return { requires2FA: true as const, twoFactorToken: data.twoFactorToken as string };
        }
        const loggedIn = data.user as AuthUser;
        setUser(loggedIn);
        localStorage.setItem("user", JSON.stringify(loggedIn));
        return loggedIn;
    }, []);

    const loginWithGoogle = useCallback(async (idToken: string) => {
        const res = await api.post("/auth/google", { token: idToken });
        const data = res.data.data;
        if (data.requires2FA) {
            return { requires2FA: true as const, twoFactorToken: data.twoFactorToken as string };
        }
        const loggedIn = data.user as AuthUser;
        setUser(loggedIn);
        localStorage.setItem("user", JSON.stringify(loggedIn));
        return loggedIn;
    }, []);

    const complete2FA = useCallback(async (token: string, code: string) => {
        const res = await api.post("/account/2fa/verify", { token, code });
        const loggedIn = res.data.data.user as AuthUser;
        setUser(loggedIn);
        localStorage.setItem("user", JSON.stringify(loggedIn));
        return loggedIn;
    }, []);

    const register = useCallback(async (data: { name: string; email: string; password: string; phone_number?: string; role?: string; referralCode?: string }) => {
        const res = await api.post("/auth/register", data);
        const registered = res.data.data.user as AuthUser;
        setUser(registered);
        localStorage.setItem("user", JSON.stringify(registered));
        return registered;
    }, []);

    const logout = useCallback(async () => {
        try {
            await api.post("/auth/logout");
        } catch {
            // Ignore server-side logout errors
        }
        setUser(null);
        localStorage.removeItem("user");
        localStorage.removeItem("token");
    }, []);

    return (
        <AuthContext.Provider value={{ user, isLoading, login, loginWithGoogle, complete2FA, register, logout, refreshProfile, setUser }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used within AuthProvider");
    return ctx;
}

// Redirects to login if not authenticated. Returns user when ready.
export function useRequireAuth() {
    const { user, isLoading } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && !user) {
            router.replace("/login");
        }
    }, [isLoading, user, router]);

    return { user, isLoading };
}
