"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import NotificationBell from "@/components/layout/NotificationBell";
import { useAuth } from "@/context/AuthContext";
import { MessageCircle } from "lucide-react";
import LanguageSwitcher from "@/components/ui/LanguageSwitcher";
import ThemeToggle from "@/components/ui/ThemeToggle";

export default function Navbar() {
    const { user } = useAuth();
    const t = useTranslations("nav");
    const tc = useTranslations("common");
    const [isVisible, setIsVisible] = useState(true);
    const [lastScrollY, setLastScrollY] = useState(0);

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollY = window.scrollY;
            setIsVisible(currentScrollY < lastScrollY || currentScrollY < 10);
            setLastScrollY(currentScrollY);
        };

        window.addEventListener("scroll", handleScroll, { passive: true });
        return () => window.removeEventListener("scroll", handleScroll);
    }, [lastScrollY]);

    return (
        <nav className={cn(
            "fixed top-0 left-0 w-full z-50 px-[5%] h-16 py-3 flex justify-between items-center bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-800 transition-transform duration-300",
            isVisible ? "translate-y-0" : "-translate-y-full"
        )}>
            <div className="flex items-center gap-10">
                <div className="flex items-center justify-center gap-2">
                    <h4 className="font-bold text-xl text-gray-900">MindEase</h4>
                    <div className="relative w-8 h-8">
                        <Image
                            src="/ImgOrIcon/Union.png"
                            alt="MindEase Logo"
                            fill
                            className="object-contain"
                        />
                    </div>
                </div>
                <ul className="flex gap-10 justify-center items-center list-none ml-4">
                    <li className="cursor-pointer text-gray-600 hover:text-indigo-600 transition-colors text-sm font-medium">
                        <Link href="/">{t("home")}</Link>
                    </li>
                    <li className="cursor-pointer text-gray-600 hover:text-indigo-600 transition-colors text-sm font-medium">
                        <Link href="/doctors">{t("findDoctors")}</Link>
                    </li>
                    <li className="cursor-pointer text-gray-600 hover:text-indigo-600 transition-colors text-sm font-medium">
                        <Link href="/appointments">{t("bookNow")}</Link>
                    </li>
                    <li className="cursor-pointer text-rose-500 hover:text-rose-600 transition-colors text-sm font-bold">
                        <Link href="/crisis">{t("crisisHelp")}</Link>
                    </li>
                    {user && (
                        <>
                            <li className="cursor-pointer text-gray-600 hover:text-indigo-600 transition-colors text-sm font-medium">
                                <Link href="/dashboard/appointments">{t("myHistory")}</Link>
                            </li>
                            <li className="cursor-pointer text-gray-600 hover:text-indigo-600 transition-colors text-sm font-medium">
                                <Link href="/messages" className="flex items-center gap-1">
                                    <MessageCircle className="w-4 h-4" />
                                    {tc("messages")}
                                </Link>
                            </li>
                        </>
                    )}
                </ul>
            </div>

            <div className="flex items-center gap-4">
                <ThemeToggle />
                <LanguageSwitcher />
                {user ? (
                    <>
                        <NotificationBell />
                        <Link
                            href="/dashboard"
                            className="text-gray-700 font-bold hover:text-indigo-600 transition-colors px-4 py-2 flex items-center gap-2"
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
                                "text-white/80 hover:text-white py-2 px-4 rounded-[10px] flex items-center text-center font-medium transition-colors",
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
    );
}
