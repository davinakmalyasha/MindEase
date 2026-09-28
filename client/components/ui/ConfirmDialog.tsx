"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
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
    if (ctx) return ctx;
    // Fallback outside the provider. `window.confirm` is inaccessible to
    // assistive technology, so this is a degraded path rather than an
    // equivalent one — callers should be inside the provider.
    return async (options) =>
        window.confirm(`${options.title}${options.message ? `\n\n${options.message}` : ""}`);
};

/**
 * Promise-based replacement for `window.confirm`.
 *
 * Wrap once near the app root, then:
 *   if (await confirm({ title: "Delete?", danger: true })) { ... }
 *
 * Focus lands on the *cancel* action, not the destructive one: a keyboard user
 * who reflexively presses Space should not delete anything.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((v: boolean) => void) | null>(null);

    const confirm = useCallback<ConfirmFn>(
        (opts) =>
            new Promise<boolean>((resolve) => {
                // A second request while one is open would overwrite the first
                // resolver, leaving the original caller pending forever. Resolve
                // the earlier one as declined rather than leaking the promise.
                resolverRef.current?.(false);
                resolverRef.current = resolve;
                setOptions(opts);
            }),
        []
    );

    const settle = useCallback((value: boolean) => {
        resolverRef.current?.(value);
        resolverRef.current = null;
        setOptions(null);
    }, []);

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <Dialog
                open={options !== null}
                onClose={() => settle(false)}
                title={options?.title ?? ""}
                tone={options?.danger ? "danger" : "default"}
                className="max-w-sm"
            >
                {options?.message && (
                    <p className="mb-6 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                        {options.message}
                    </p>
                )}

                <div className="flex items-start gap-3">
                    <div
                        aria-hidden="true"
                        className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl",
                            options?.danger
                                ? "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400"
                                : "bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                        )}
                    >
                        <AlertTriangle className="h-5 w-5" />
                    </div>
                </div>

                <div className="mt-6 flex gap-3">
                    <button
                        type="button"
                        onClick={() => settle(false)}
                        data-autofocus
                        className="flex-1 rounded-2xl bg-gray-100 py-3 text-sm font-bold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                        {options?.cancelLabel || "Cancel"}
                    </button>
                    <button
                        type="button"
                        onClick={() => settle(true)}
                        className={cn(
                            "flex-1 rounded-2xl py-3 text-sm font-bold text-white transition-all active:scale-95",
                            options?.danger
                                ? "bg-rose-600 hover:bg-rose-700"
                                : "bg-indigo-600 hover:bg-indigo-700"
                        )}
                    >
                        {options?.confirmLabel || "Confirm"}
                    </button>
                </div>
            </Dialog>
        </ConfirmContext.Provider>
    );
}
