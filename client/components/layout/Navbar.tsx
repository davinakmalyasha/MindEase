"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import NotificationBell from "@/components/layout/NotificationBell";
import { useAuth } from "@/context/AuthContext";
import { MessageCircle, Menu, X, Heart } from "lucide-react";
import LanguageSwitcher from "@/components/ui/LanguageSwitcher";
import ThemeToggle from "@/components/ui/ThemeToggle";

export default function Navbar() {
    const { user } = useAuth();
    const t = useTranslations("nav");
    const tc = useTranslations("common");
    const pathname = usePathname();
    const [isVisible, setIsVisible] = useState(true);
    const [lastScrollY, setLastScrollY] = useState(0);
    const [mobileOpen, setMobileOpen] = useState(false);

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollY = window.scrollY;
            setIsVisible(currentScrollY < lastScrollY || currentScrollY < 10);
            setLastScrollY(currentScrollY);
        };

        window.addEventListener("scroll", handleScroll, { passive: true });
        return () => window.removeEventListener("scroll", handleScroll);
    }, [lastScrollY]);

    // A route change should never leave the drawer covering the page it
    // navigated to. Escape closes it, and the body must not scroll behind it.
    useEffect(() => {
        setMobileOpen(false);
    }, [pathname]);

    useEffect(() => {
        if (!mobileOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMobileOpen(false);
        };
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        document.addEventListener("keydown", onKey);
        return () => {
            document.body.style.overflow = previous;
            document.removeEventListener("keydown", onKey);
        };
    }, [mobileOpen]);

    // Shared by the desktop list and the mobile drawer. The drawer wraps
    // this in its own padded list, so no spacing lives on the items here.
    const links = (
        <>
            <li className="cursor-pointer text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 transition-colors text-sm font-medium">
                <Link href="/">{t("home")}</Link>
            </li>
            <li className="cursor-pointer text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 transition-colors text-sm font-medium">
                <Link href="/doctors">{t("findDoctors")}</Link>
            </li>
            <li className="cursor-pointer text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 transition-colors text-sm font-medium">
                <Link href="/appointments">{t("bookNow")}</Link>
            </li>
            <li className="cursor-pointer text-rose-500 hover:text-rose-600 transition-colors text-sm font-bold">
                <Link href="/crisis">{t("crisisHelp")}</Link>
            </li>
            {user && (
                <>
                    <li className="cursor-pointer text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 transition-colors text-sm font-medium">
                        <Link href="/dashboard/appointments">{t("myHistory")}</Link>
                    </li>
                    <li className="cursor-pointer text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 transition-colors text-sm font-medium">
                        <Link href="/messages" className="flex items-center gap-1">
                            <MessageCircle className="w-4 h-4" />
                            {tc("messages")}
                        </Link>
                    </li>
                </>
            )}
        </>
    );

    return (
        <>
        <nav className={cn(
            "fixed top-0 left-0 w-full z-50 px-[5%] h-16 py-3 flex justify-between items-center bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-800 transition-transform duration-300",
            isVisible ? "translate-y-0" : "-translate-y-full"
        )}>
            <div className="flex items-center gap-10">
                <Link href="/" className="flex items-center justify-center gap-2" aria-label={t("homeLabel")}>
                    <h4 className="font-bold text-xl text-gray-900 dark:text-white">MindEase</h4>
                    <span className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
                        <Heart className="w-4 h-4 text-white" aria-hidden="true" />
                    </span>
                </Link>
                <ul className="hidden lg:flex gap-10 justify-center items-center list-none ml-4">
                    {links}
                </ul>
            </div>

            <div className="flex items-center gap-2 md:gap-4">
                <button
                    type="button"
                    onClick={() => setMobileOpen(true)}
                    aria-label={t("openMenu")}
                    aria-expanded={mobileOpen}
                    aria-haspopup="dialog"
                    className="lg:hidden p-2 rounded-xl text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                    <Menu className="w-5 h-5" />
                </button>
                <ThemeToggle />
                <div className="hidden sm:block">
                    <LanguageSwitcher />
                </div>
                {user ? (
                    <>
                        <NotificationBell />
                        <Link
                            href="/dashboard"
                            className="text-gray-700 font-bold hover:text-indigo-600 transition-colors px-4 py-2 hidden sm:flex items-center gap-2 dark:text-gray-200"
                        >
                            <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center overflow-hidden border border-indigo-100">
                                {/* Decorative: the user's name sits directly beside
                                    this image, so an alt would be announced twice. */}
                                {user.avatar ? <img src={user.avatar} alt="" className="w-full h-full object-cover" /> : <div className="text-[10px]" aria-hidden="true">{user.name?.[0]}</div>}
                            </div>
                            {user.name}
                        </Link>
                    </>
                ) : (
                    <div className="flex items-center gap-2">
                        {/* `/register` is a full working page that nothing linked
                            to, so a prospective patient had no route to sign up
                            except finding the tab buried inside the login page. */}
                        <Link
                            href="/register"
                            className={cn(
                                "text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-white py-2 px-4 rounded-[10px] flex items-center text-center font-medium transition-colors",
                                "hidden sm:flex"
                            )}
                        >
                            {t("signUp")}
                        </Link>
                        <Link
                            href="/login"
                            className={cn(
                                "text-white py-2 px-6 rounded-[10px] flex justify-center items-center text-center font-medium",
                                "bg-gradient-to-r from-[#4837F2] to-[#8643FF]",
                                "hover:opacity-90 transition-all hover:shadow-lg active:scale-95"
                            )}
                        >
                            {t("signIn")}
                        </Link>
                    </div>
                )}
            </div>
        </nav>

        {mobileOpen && (
            <div className="lg:hidden fixed inset-0 z-50">
                <button
                    type="button"
                    aria-label={t("closeMenu")}
                    onClick={() => setMobileOpen(false)}
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
                            <span className="w-6 h-6 rounded-lg bg-indigo-600 flex items-center justify-center">
                                <Heart className="w-3.5 h-3.5 text-white" aria-hidden="true" />
                            </span>
                        </Link>
                        <button
                            type="button"
                            onClick={() => setMobileOpen(false)}
                            aria-label={t("closeMenu")}
                            className="p-2 -mr-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <nav aria-label={t("mainNavigation")} className="flex-1 px-3 py-6 overflow-y-auto">
                        <ul className="space-y-1 list-none [&>li]:px-3 [&>li]:py-2.5 [&>li]:rounded-xl [&>li]:hover:bg-gray-50 dark:[&>li]:hover:bg-gray-800">
                            {links}
                        </ul>
                    </nav>

                    <div className="px-5 pb-5 pt-4 border-t border-gray-100 dark:border-gray-800">
                        <LanguageSwitcher />
                    </div>
                </aside>
            </div>
        )}
        </>
    );
}
