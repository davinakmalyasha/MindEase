"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmOptions {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const useConfirm = (): ConfirmFn => {
    const ctx = useContext(ConfirmContext);
    if (!ctx) {
        // Fallback outside the provider — behave like window.confirm
        return async (options) => window.confirm(`${options.title}${options.message ? `\n\n${options.message}` : ""}`);
    }
    return ctx;
};

/**
 * Promise-based replacement for window.confirm(). Wrap once near the app root:
 *   <ConfirmProvider>...</ConfirmProvider>
 * then:  if (await confirm({ title: "Delete?", danger: true })) { ... }
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((v: boolean) => void) | null>(null);

    const confirm = useCallback<ConfirmFn>((opts) => {
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
            setOptions(opts);
        });
    }, []);

    const settle = (value: boolean) => {
        resolverRef.current?.(value);
        resolverRef.current = null;
        setOptions(null);
    };

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <AnimatePresence>
                {options && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
                        onClick={() => settle(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.92, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.92, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            role="alertdialog"
                            aria-modal="true"
                            className="bg-white rounded-3xl p-7 max-w-sm w-full shadow-2xl"
                        >
                            <div className="flex items-start gap-3 mb-5">
                                <div className={cn(
                                    "w-10 h-10 rounded-2xl flex items-center justify-center shrink-0",
                                    options.danger ? "bg-rose-100 text-rose-600" : "bg-indigo-100 text-indigo-600"
                                )}>
                                    <AlertTriangle className="w-5 h-5" />
                                </div>
                                <div>
                                    <h3 className="font-black text-gray-900">{options.title}</h3>
                                    {options.message && (
                                        <p className="text-sm text-gray-500 mt-1 leading-relaxed">{options.message}</p>
                                    )}
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => settle(true)}
                                    autoFocus
                                    className={cn(
                                        "flex-1 py-3 rounded-2xl font-bold text-sm text-white transition-all active:scale-95",
                                        options.danger ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"
                                    )}
                                >
                                    {options.confirmLabel || "Confirm"}
                                </button>
                                <button
                                    onClick={() => settle(false)}
                                    className="px-5 py-3 rounded-2xl font-bold text-sm text-gray-500 hover:bg-gray-100 transition-all"
                                >
                                    {options.cancelLabel || "Cancel"}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </ConfirmContext.Provider>
    );
}
