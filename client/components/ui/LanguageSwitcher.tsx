"use client";

import { useLocale } from "next-intl";
import { Languages } from "lucide-react";
import { usePathname } from "next/navigation";

const LOCALES = [
    { code: "en", label: "EN" },
    { code: "id", label: "ID" },
];

export default function LanguageSwitcher() {
    const locale = useLocale();
    const pathname = usePathname();

    const switchLocale = (code: string) => {
        // eslint-disable-next-line react-hooks/immutability
        document.cookie = `locale=${code}; path=/; max-age=31536000; SameSite=Lax`;
        // eslint-disable-next-line react-hooks/immutability
        window.location.href = pathname;
    };

    return (
        <div className="flex items-center gap-1 bg-gray-50 rounded-xl p-1">
            <Languages className="w-4 h-4 text-gray-400 mr-0.5" />
            {LOCALES.map((l) => (
                <button
                    key={l.code}
                    onClick={() => switchLocale(l.code)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                        locale === l.code ? "bg-indigo-600 text-white shadow-sm" : "text-gray-500 hover:text-gray-800"
                    }`}
                >
                    {l.label}
                </button>
            ))}
        </div>
    );
}
