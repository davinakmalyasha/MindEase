"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    LayoutDashboard,
    Calendar,
    History,
    User as UserIcon,
    ShieldCheck,
    ShieldAlert,
    Target,
    LifeBuoy,
    HeartPulse,
    MessageCircle,
    Bell,
    LogOut,
    CalendarClock,
    Sparkles,
    Lock,
    BookOpen,
    ClipboardCheck,
    BarChart3,
    Menu,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import Avatar from "@/components/ui/Avatar";
import NotificationBell from "@/components/layout/NotificationBell";
import LanguageSwitcher from "@/components/ui/LanguageSwitcher";
import ThemeToggle from "@/components/ui/ThemeToggle";
import CrisisBanner from "@/components/ui/CrisisBanner";
import SOSButton from "@/components/ui/SOSButton";

type NavItem = {
    /** Stable identity. Not the href - two entries may share a destination. */
    id: string;
    label: string;
    href: string;
    icon: typeof LayoutDashboard;
    roles: string[];
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { user, logout, isLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const { toast } = useToast();
    const t = useTranslations("dashboard");
    const tc = useTranslations("common");
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    const NAV_ITEMS = useMemo<NavItem[]>(() => {
        const items: NavItem[] = [
            { id: "dashboard", label: tc("dashboard"), href: "/dashboard", icon: LayoutDashboard, roles: ["patient", "doctor", "admin"] },
            { id: "findSpecialist", label: t("findSpecialist"), href: "/appointments", icon: Calendar, roles: ["patient"] },
            { id: "myAppointments", label: t("myAppointments"), href: "/dashboard/appointments", icon: History, roles: ["patient", "doctor"] },
            { id: "moodTracker", label: t("moodTracker"), href: "/dashboard/mood", icon: HeartPulse, roles: ["patient"] },
            { id: "assessments", label: t("assessments"), href: "/dashboard/assessments", icon: ClipboardCheck, roles: ["patient"] },
            { id: "journal", label: t("journal"), href: "/dashboard/journal", icon: BookOpen, roles: ["patient"] },
            { id: "carePlan", label: t("carePlan"), href: "/dashboard/care-plan", icon: Target, roles: ["patient"] },
            { id: "safetyPlan", label: t("safetyPlan"), href: "/dashboard/safety-plan", icon: LifeBuoy, roles: ["patient"] },
            { id: "mySchedule", label: t("mySchedule"), href: "/dashboard/doctor/schedule", icon: CalendarClock, roles: ["doctor"] },
            // The triage queue. Placed first among the clinician entries because it is
            // the one page that can contain something time-critical.
            { id: "riskQueue", label: t("riskQueue"), href: "/dashboard/doctor/risk", icon: ShieldAlert, roles: ["doctor"] },
            // Was pointed at `/dashboard/appointments`, the same href as
            // "My Appointments". Two nav entries, one destination: both highlighted at
            // once, and this one landed on a page with no briefings on it. There was
            // no `/dashboard/briefing` index at all - the only briefing route was
            // `/dashboard/briefing/[appointmentId]`, reachable by typing a URL.
            { id: "aiBriefings", label: t("aiBriefings"), href: "/dashboard/briefing", icon: Sparkles, roles: ["doctor"] },
            { id: "analytics", label: t("analytics"), href: "/dashboard/analytics", icon: BarChart3, roles: ["doctor"] },
            { id: "adminOverview", label: t("adminOverview"), href: "/dashboard/admin", icon: ShieldCheck, roles: ["admin"] },
            { id: "messages", label: tc("messages"), href: "/messages", icon: MessageCircle, roles: ["patient", "doctor"] },
            { id: "notifications", label: tc("notifications"), href: "/notifications", icon: Bell, roles: ["patient", "doctor", "admin"] },
            { id: "profile", label: tc("profile"), href: "/dashboard/profile", icon: UserIcon, roles: ["patient", "doctor", "admin"] },
            // Was the literal string "Security", the only untranslated label in the list.
            { id: "security", label: tc("security"), href: "/dashboard/security", icon: Lock, roles: ["patient", "doctor", "admin"] },
        ];
        return user ? items.filter((item) => item.roles.includes(user.role)) : [];
    }, [user, t, tc]);

    const handleLogout = async () => {
        setMobileNavOpen(false);
        await logout();
        toast(tc("logoutSuccess"), "success");
        router.push("/login");
    };

    const isActive = (href: string) =>
        href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

    // A route change should never leave the drawer covering the page it navigated
    // to. An effect is the only place that knows both happened.
    useEffect(() => {
        setMobileNavOpen(false);
    }, [pathname]);

    // Escape closes it, and the body must not scroll behind it.
    useEffect(() => {
        if (!mobileNavOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMobileNavOpen(false);
        };
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        document.addEventListener("keydown", onKey);
        return () => {
            document.body.style.overflow = previous;
            document.removeEventListener("keydown", onKey);
        };
    }, [mobileNavOpen]);

    if (isLoading || !user) {
        return (
            <main className="min-h-screen bg-gray-50 flex items-center justify-center">
                <div className="w-12 h-12 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
            </main>
        );
    }

    const navList = (
        <nav aria-label={t("mainNavigation")} className="flex-1 px-3 py-6 space-y-1 overflow-y-auto custom-scrollbar">
            {NAV_ITEMS.map((item) => (
                <Link
                    key={item.id}
                    href={item.href}
                    aria-current={isActive(item.href) ? "page" : undefined}
                    className={cn(
                        "flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all group",
                        isActive(item.href)
                            ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200"
                            : "text-gray-500 hover:bg-indigo-50 hover:text-indigo-600"
                    )}
                >
                    <item.icon className="w-[18px] h-[18px]" />
                    {item.label}
                </Link>
            ))}
        </nav>
    );

    return (
        <div className="min-h-screen bg-gray-50 flex">
            {/* Sidebar */}
            <aside className="hidden lg:flex flex-col w-64 shrink-0 bg-white dark:bg-gray-900 border-r border-gray-100 dark:border-gray-800 sticky top-0 h-screen">
                <Link href="/" className="flex items-center gap-2 px-6 py-6 border-b border-gray-50">
                    <span className="text-xl font-extrabold text-gray-900">MindEase</span>
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                </Link>

                {navList}

                <div className="px-3 pb-6 space-y-2 border-t border-gray-50 pt-4">
                    <div className="flex items-center gap-3 px-4 py-3">
                        <Avatar src={user.avatar} name={user.name} size="sm" />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-gray-900 truncate">{user.name}</p>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-500">{user.role}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <NotificationBell />
                            <ThemeToggle />
                        </div>
                    </div>
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-bold text-rose-500 hover:bg-rose-50 transition-all"
                    >
                        <LogOut className="w-4 h-4" />
                        {tc("logout")}
                    </button>
                </div>
            </aside>

            {/*
              Mobile navigation.

              The sidebar is `hidden lg:flex`, so below `lg` the entire nav was
              unreachable: the mobile bar had a logo, a theme toggle, a bell, an SOS
              button and an avatar, and no way to reach mood, journal, care plan,
              safety plan, appointments, messages or profile. On a phone - the
              device a patient in distress is most likely holding - a logged-in
              user could reach exactly two pages.

              Rendered here rather than pulled into a component because it shares
              `NAV_ITEMS` and `navList` with the sidebar by construction; extracting
              it would mean passing both down and re-plumbing the active state for
              one call site.
            */}
            {mobileNavOpen && (
                <div className="lg:hidden fixed inset-0 z-50">
                    <button
                        type="button"
                        aria-label={t("closeNavigation")}
                        onClick={() => setMobileNavOpen(false)}
                        className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
                    />
                    <aside
                        role="dialog"
                        aria-modal="true"
                        aria-label={t("mainNavigation")}
                        className="absolute inset-y-0 left-0 w-72 max-w-[85vw] flex flex-col bg-white dark:bg-gray-900 shadow-2xl"
                    >
                        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                            <Link href="/" className="flex items-center gap-2">
                                <span className="text-lg font-extrabold text-gray-900 dark:text-white">MindEase</span>
                                <span className="w-2 h-2 rounded-full bg-indigo-500" />
                            </Link>
                            <button
                                type="button"
                                onClick={() => setMobileNavOpen(false)}
                                aria-label={t("closeNavigation")}
                                className="p-2 -mr-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {navList}

                        <div className="px-3 pb-5 space-y-3 border-t border-gray-100 dark:border-gray-800 pt-4">
                            <div className="flex items-center gap-3 px-3 py-2">
                                <Avatar src={user.avatar} name={user.name} size="sm" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
                                        {user.name}
                                    </p>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-500">
                                        {user.role}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-2 px-1">
                                <LanguageSwitcher />
                                <ThemeToggle />
                                <NotificationBell />
                            </div>
                            <button
                                onClick={handleLogout}
                                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-bold text-rose-500 hover:bg-rose-50 transition-all"
                            >
                                <LogOut className="w-4 h-4" />
                                {tc("logout")}
                            </button>
                        </div>
                    </aside>
                </div>
            )}

            {/* Mobile top bar */}
            <div className="lg:hidden fixed top-0 inset-x-0 z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-100 dark:border-gray-800 px-4 py-3 flex items-center justify-between">
                <button
                    type="button"
                    onClick={() => setMobileNavOpen(true)}
                    aria-label={t("openNavigation")}
                    aria-expanded={mobileNavOpen}
                    aria-haspopup="dialog"
                    className="p-2 -ml-2 rounded-xl text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                    <Menu className="w-5 h-5" />
                </button>
                <Link href="/" className="text-lg font-extrabold text-gray-900 dark:text-white">
                    MindEase
                </Link>
                <div className="flex items-center gap-3">
                    <ThemeToggle />
                    <NotificationBell />
                    {user.role === "patient" && <SOSButton />}
                    <Link href="/dashboard/profile">
                        <Avatar src={user.avatar} name={user.name} size="sm" />
                    </Link>
                </div>
            </div>

            {/* Main content */}
            <main className="flex-1 min-w-0 pt-16 lg:pt-0">
                <div className="px-4 md:px-8 py-8 max-w-7xl mx-auto">
                    {user.role !== "admin" && user.isVerified === false && (
                        <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 justify-between p-4 rounded-2xl bg-amber-50 border border-amber-200">
                            <p className="text-sm text-amber-800">
                                <span className="font-bold">Verify your email</span> to secure your account and
                                receive important notifications.
                            </p>
                            <Link
                                href={`/verify-email?email=${encodeURIComponent(user.email || "")}`}
                                className="shrink-0 px-4 py-2 bg-amber-500 text-white rounded-xl font-bold text-xs hover:bg-amber-600 transition-all"
                            >
                                Verify now
                            </Link>
                        </div>
                    )}
                    <CrisisBanner />
                    {children}
                </div>
            </main>
        </div>
    );
}