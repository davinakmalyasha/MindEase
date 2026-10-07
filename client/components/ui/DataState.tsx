"use client";

import { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * The three states a data-backed panel can be in, as components.
 *
 * ## Why this exists
 *
 * `ErrorBoundary` catches a component that throws during render. It does nothing
 * for a fetch that fails, which is the common case: the promise rejects, the
 * `.catch(() => {})` swallows it, `state` stays `null`, and the JSX guard
 * `stats && (...)` renders nothing.
 *
 * That is not an empty state. It is not a loading state. It is the *absence* of
 * one, and it looks identical whether the request is in flight, succeeded with
 * nothing to show, or failed. A doctor's practice statistics can fail to load and
 * the page presents exactly as it does on a first visit, forever, with no
 * spinner to end and no message to read. There was no error state to render,
 * because there was no error state in the component.
 *
 * So the three are separate components with separate meanings, and the type of the
 * data decides which one appears. `stats === null` before the request resolves is
 * a *different state* from `stats === null` because the request failed, and
 * conflating them is the whole bug.
 */

const tone = {
  info: {
    icon: RefreshCw,
    ring: "border-gray-200 bg-gray-50",
    text: "text-gray-600",
    spin: true,
  },
  error: {
    icon: AlertTriangle,
    ring: "border-rose-200 bg-rose-50",
    text: "text-rose-700",
    spin: false,
  },
} as const;

/** Shown while a request is in flight and nothing has arrived yet. */
export function LoadingState({ label, className }: { label?: string; className?: string }) {
    const t = useTranslations("common");
    const Icon = tone.info.icon;

    return (
        <div
            // Announced, and not merely shown. A spinner that a screen reader
            // never mentions is a spinner that does not exist for one out of four
            // users trying to work out whether the page is still loading.
            role="status"
            aria-live="polite"
            className={cn(
                "flex items-center justify-center gap-3 rounded-2xl border border-gray-200 bg-gray-50 px-6 py-10 text-sm",
                className
            )}
        >
            <Icon className="h-4 w-4 animate-spin text-gray-400" aria-hidden="true" />
            <span className="text-gray-600">{label ?? t("loading")}</span>
        </div>
    );
}

/**
 * Shown when a request failed.
 *
 * `onRetry` is not optional in spirit even though it is in the type: a failure a
 * user cannot act on is a dead end, and "try again" is the cheapest action any
 * failure can offer.
 */
export function ErrorState({
    title,
    detail,
    onRetry,
    retryLabel,
    className,
}: {
    title?: string;
    detail?: string;
    onRetry?: () => void;
    retryLabel?: string;
    className?: string;
}) {
    const t = useTranslations("common");
    const Icon = tone.error.icon;

    return (
        <div
            role="alert"
            className={cn(
                "flex flex-col items-center justify-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-8 text-center",
                className
            )}
        >
            <Icon className="h-5 w-5 text-rose-600" aria-hidden="true" />
            <div>
                {/* The message the user sees is not the same as the message a log
                    line needs. `detail` is for a human; the underlying error is
                    not rendered, because an axios error body can contain a stack
                    trace and a request id and belongs in the console. */}
                <p className="text-sm font-semibold text-rose-800">{title ?? t("somethingWentWrong")}</p>
                {detail && <p className="mt-1 text-xs text-rose-700">{detail}</p>}
            </div>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-white px-4 py-2 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {retryLabel ?? t("tryAgain")}
                </button>
            )}
        </div>
    );
}

/**
 * Shown when a request succeeded and there is genuinely nothing to display.
 *
 * Distinct from both of the above on purpose, and the reason it exists is that
 * "nothing here" and "I could not find out what is here" must not look the same.
 */
export function EmptyState({
    title,
    detail,
    action,
    className,
}: {
    title: string;
    detail?: string;
    action?: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center",
                className
            )}
        >
            <p className="text-sm font-semibold text-gray-700">{title}</p>
            {detail && <p className="max-w-sm text-xs text-gray-500">{detail}</p>}
            {action}
        </div>
    );
}