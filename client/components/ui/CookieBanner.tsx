"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Cookie } from "lucide-react";

const STORAGE_KEY = "mindease-cookie-consent";

export default function CookieBanner() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (typeof window !== "undefined" && !localStorage.getItem(STORAGE_KEY)) {
                setVisible(true);
            }
        }, 0);
        return () => clearTimeout(timer);
    }, []);

    const choose = (value: string) => {
        localStorage.setItem(STORAGE_KEY, value);
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <div className="fixed bottom-6 left-6 z-[80] max-w-sm bg-white rounded-3xl shadow-2xl border border-gray-100 p-6">
            <div className="flex items-center gap-2 mb-3">
                <Cookie className="w-5 h-5 text-indigo-500" />
                <h3 className="font-black text-gray-900">Cookies & privacy</h3>
            </div>
            <p className="text-sm text-gray-500 leading-relaxed mb-5">
                We use essential cookies to keep you signed in and remember your preferences. We do not
                use advertising cookies, and we never sell your data.{" "}
                <Link href="/privacy#cookies" className="text-indigo-600 font-bold underline underline-offset-2">
                    Learn more
                </Link>
            </p>
            <div className="flex gap-3">
                <button
                    onClick={() => choose("accepted")}
                    className="flex-1 px-4 py-2.5 bg-indigo-600 text-white text-sm font-black rounded-xl hover:bg-indigo-700 transition-all"
                >
                    Accept
                </button>
                <button
                    onClick={() => choose("declined")}
                    className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-600 text-sm font-black rounded-xl hover:bg-gray-200 transition-all"
                >
                    Decline
                </button>
            </div>
        </div>
    );
}
