"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import { cn } from "@/lib/utils";

/**
 * A single field the dialog collects before resolving.
 *
 * Used where an action needs re-authentication rather than just consent —
 * account deletion, rotating a credential, changing an email. The server
 * enforces this (`DeleteAccountSchema` requires `password`); without a way to
 * collect the value the request simply 400s, which is what happened: the
 * deletion endpoint was fully implemented and tested on the server and
 * completely unreachable from the product.
 */
export interface ConfirmField {
    name: string;
    label: string;
    type?: "text" | "password";
    placeholder?: string;
    autoComplete?: string;
    /** Disables the confirm button until a non-empty value is entered. */
    required?: boolean;
}

export interface ConfirmOptions {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    /** Collects one credential before resolving `true`. */
    field?: ConfirmField;
    /** Hint shown under the field, e.g. where to obtain the code. */
    fieldHint?: string;
}

/** Resolves `true` when confirmed, or the collected value when a field is set. */
export type ConfirmResult = boolean | string;

type ConfirmFn = (options: ConfirmOptions) => Promise<ConfirmResult>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const useConfirm = (): ConfirmFn => {
    const ctx = useContext(ConfirmContext);
    if (ctx) return ctx;
    // Fallback outside the provider. `window.confirm` is inaccessible to
    // assistive technology and cannot collect input, so any caller that needs a
    // field must be inside the provider.
    return async (options) => {
        const ok = window.confirm(
            `${options.title}${options.message ? `\n\n${options.message}` : ""}`
        );
        return options.field ? false : ok;
    };
};

/**
 * Promise-based replacement for `window.confirm`.
 *
 * Wrap once near the app root, then:
 *   if (await confirm({ title: "Delete?", danger: true })) { ... }
 *
 * Or to collect a credential:
 *   const code = await confirm({ title: "Confirm it's you", field: {...}, danger: true });
 *   if (typeof code === "string") { ... }
 *
 * Focus lands on the *cancel* action, not the destructive one: a keyboard user
 * who reflexively presses Space should not delete anything. When a field is
 * required, focus moves to it instead, because there is nothing else to confirm
 * without it.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const [value, setValue] = useState("");
    const resolverRef = useRef<((v: ConfirmResult) => void) | null>(null);

    const confirm = useCallback<ConfirmFn>(
        (opts) =>
            new Promise<ConfirmResult>((resolve) => {
                // A second request while one is open would overwrite the first
                // resolver, leaving the original caller pending forever. Resolve
                // the earlier one as declined rather than leaking the promise.
                resolverRef.current?.(false);
                resolverRef.current = resolve;
                setValue("");
                setOptions(opts);
            }),
        []
    );

    const settle = useCallback((result: ConfirmResult) => {
        resolverRef.current?.(result);
        resolverRef.current = null;
        setOptions(null);
        setValue("");
    }, []);

    const field = options?.field;
    const blocked = !!field?.required && value.trim().length === 0;

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
                    <p className="mb-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                        {options.message}
                    </p>
                )}

                <div
                    aria-hidden="true"
                    className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-2xl",
                        options?.danger
                            ? "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400"
                            : "bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                    )}
                >
                    <AlertTriangle className="h-5 w-5" />
                </div>

                {field && (
                    <div className="mt-5">
                        <label
                            htmlFor="confirm-field"
                            className="block text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400"
                        >
                            {field.label}
                        </label>
                        <input
                            id="confirm-field"
                            data-autofocus
                            type={field.type ?? "text"}
                            value={value}
                            autoComplete={field.autoComplete ?? "off"}
                            placeholder={field.placeholder}
                            onChange={(e) => setValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !blocked) {
                                    e.preventDefault();
                                    settle(field.required ? value : true);
                                }
                            }}
                            className="mt-2 w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                        />
                        {options?.fieldHint && (
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                                {options.fieldHint}
                            </p>
                        )}
                    </div>
                )}

                <div className="mt-6 flex gap-3">
                    <button
                        type="button"
                        onClick={() => settle(false)}
                        {...(field ? {} : { "data-autofocus": true })}
                        className="flex-1 rounded-2xl bg-gray-100 py-3 text-sm font-bold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                        {options?.cancelLabel || "Cancel"}
                    </button>
                    <button
                        type="button"
                        disabled={blocked}
                        onClick={() => settle(field ? value : true)}
                        className={cn(
                            "flex-1 rounded-2xl py-3 text-sm font-bold text-white transition-all active:scale-95 disabled:cursor-not-allowed",
                            options?.danger
                                ? "bg-rose-600 hover:bg-rose-700 disabled:opacity-50"
                                : "bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                        )}
                    >
                        {options?.confirmLabel || "Confirm"}
                    </button>
                </div>
            </Dialog>
        </ConfirmContext.Provider>
    );
}
