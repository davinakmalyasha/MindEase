"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The single modal primitive for the app.
 *
 * Every dialog in the product previously hand-rolled its own overlay and
 * inherited the same set of defects: no `role="dialog"`, no `aria-modal`, no
 * Escape handler, no focus trap, no focus restoration and no scroll lock. That
 * made the booking flow, the review form and — most seriously — the crisis SOS
 * panel unusable with a keyboard or a screen reader.
 *
 * This component owns all of it so the behaviour cannot drift per call site.
 */
export interface DialogProps {
    open: boolean;
    onClose: () => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
    /** Rendered as a row of actions under the body. */
    footer?: React.ReactNode;
    /** Blocks backdrop click and Escape for decisions that must be made. */
    dismissible?: boolean;
    tone?: "default" | "danger";
    className?: string;
}

const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    dismissible = true,
    tone = "default",
    className,
}: DialogProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const previouslyFocused = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const descriptionId = useId();

    const requestClose = useCallback(() => {
        if (dismissible) onClose();
    }, [dismissible, onClose]);

    // Escape to dismiss, and Tab cycles within the panel.
    useEffect(() => {
        if (!open) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                requestClose();
                return;
            }
            if (event.key !== "Tab") return;

            const panel = panelRef.current;
            if (!panel) return;

            const focusable = Array.from(
                panel.querySelectorAll<HTMLElement>(FOCUSABLE)
            ).filter((el) => el.offsetParent !== null || el === document.activeElement);

            if (focusable.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement as HTMLElement | null;

            if (event.shiftKey && (active === first || !panel.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [open, requestClose]);

    // Move focus in on open, restore it on close, and stop the page behind
    // from scrolling while the overlay is up.
    useEffect(() => {
        if (!open) return;

        previouslyFocused.current = document.activeElement as HTMLElement | null;

        const { body } = document;
        const previousOverflow = body.style.overflow;
        const previousPadding = body.style.paddingRight;
        const scrollbar = window.innerWidth - document.documentElement.clientWidth;
        body.style.overflow = "hidden";
        if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

        const focusTimer = window.setTimeout(() => {
            const panel = panelRef.current;
            if (!panel) return;
            const target = panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel;
            target.focus();
        }, 0);

        return () => {
            window.clearTimeout(focusTimer);
            body.style.overflow = previousOverflow;
            body.style.paddingRight = previousPadding;
            previouslyFocused.current?.focus?.();
        };
    }, [open]);

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={requestClose}
                >
                    <motion.div
                        ref={panelRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={titleId}
                        aria-describedby={description ? descriptionId : undefined}
                        tabIndex={-1}
                        initial={{ scale: 0.97, opacity: 0, y: 8 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.97, opacity: 0, y: 8 }}
                        transition={{ duration: 0.18 }}
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                            "w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl outline-none dark:bg-gray-900",
                            className
                        )}
                    >
                        <div className="mb-5 flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <h2
                                    id={titleId}
                                    className={cn(
                                        "text-lg font-black text-gray-900 dark:text-gray-50",
                                        tone === "danger" && "text-rose-700 dark:text-rose-400"
                                    )}
                                >
                                    {title}
                                </h2>
                                {description && (
                                    <p
                                        id={descriptionId}
                                        className="mt-1 text-sm text-gray-600 dark:text-gray-300"
                                    >
                                        {description}
                                    </p>
                                )}
                            </div>
                            {dismissible && (
                                <button
                                    type="button"
                                    onClick={onClose}
                                    aria-label="Close dialog"
                                    className="-mr-1 -mt-1 shrink-0 rounded-xl p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            )}
                        </div>

                        {children}

                        {footer && <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div>}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
