"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Users, Calendar, User, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
    { name: "Home", icon: Home, href: "/" },
    { name: "Doctors", icon: Users, href: "/doctors" },
    { name: "Appointments", icon: Calendar, href: "/appointments" },
    { name: "Profile", icon: User, href: "/profile" },
];

export default function BottomBar() {
    const pathname = usePathname();

    return (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-md">
            <nav className="flex items-center justify-around px-4 py-3 bg-white/70 backdrop-blur-xl border border-white/20 rounded-[2rem] shadow-[0_8px_32px_rgba(0,0,0,0.1)] transition-all">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "relative group flex flex-col items-center justify-center p-2 rounded-2xl transition-all duration-300",
                                isActive ? "text-indigo-600 scale-110" : "text-gray-400 hover:text-indigo-400"
                            )}
                        >
                            <Icon size={24} strokeWidth={isActive ? 2.5 : 2} />
                            {isActive && (
                                <span className="absolute -bottom-1 w-1 h-1 bg-indigo-600 rounded-full" />
                            )}

                            {/* Tooltip for desktop if needed, though hidden here */}
                            <span className="sr-only">{item.name}</span>

                            {/* Particle effect on hover */}
                            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                <div className="absolute inset-0 bg-indigo-500/10 blur-md rounded-full" />
                            </div>
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
