"use client";

import { createContext, useContext, useCallback, useState, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface Toast {
    id: number;
    type: ToastType;
    message: string;
}

interface ToastContextValue {
    toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastType, ReactNode> = {
    success: <CheckCircle2 className="w-5 h-5 text-emerald-500" />,
    error: <XCircle className="w-5 h-5 text-rose-500" />,
    info: <Info className="w-5 h-5 text-indigo-500" />,
};

const STYLES: Record<ToastType, string> = {
    success: "border-emerald-100 bg-emerald-50/90",
    error: "border-rose-100 bg-rose-50/90",
    info: "border-indigo-100 bg-indigo-50/90",
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const toast = useCallback(
        (message: string, type: ToastType = "info") => {
            const id = nextId++;
            setToasts((prev) => [...prev, { id, type, message }]);
            setTimeout(() => dismiss(id), 4000);
        },
        [dismiss]
    );

    return (
        <ToastContext.Provider value={{ toast }}>
            {children}
            {/* `role="status"` with `aria-live="polite"` is what makes these
                readable by a screen reader. Without it the toast is purely
                visual: the container is announced as nothing, so a user who
                cannot see the corner of the screen gets no indication that
                their booking succeeded or failed.

                `aria-atomic` makes each toast read as a whole sentence rather
                than only the changed text, and the container is kept in the DOM
                (rather than conditionally rendered) so assistive technology has
                a live region to observe from first load. `pointer-events-none`
                on the wrapper keeps the announcement from blocking clicks on
                anything underneath. */}
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="fixed top-20 right-4 z-[200] flex flex-col gap-2 w-full max-w-sm pointer-events-none"
            >
                <AnimatePresence>
                    {toasts.map((t) => (
                        <motion.div
                            key={t.id}
                            initial={{ opacity: 0, x: 60 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 60 }}
                            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-lg shadow-black/5 backdrop-blur-sm ${STYLES[t.type]}`}
                        >
                            {ICONS[t.type]}
                            <p className="text-sm font-semibold text-gray-800 flex-1">{t.message}</p>
                            <button onClick={() => dismiss(t.id)} className="text-gray-400 hover:text-gray-600 transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used within ToastProvider");
    return ctx;
}
