import { Bot, ListChecks } from "lucide-react";

export type AiSource = "model" | "fallback";

/**
 * States where AI-assisted content came from.
 *
 * Several features degrade to a deterministic local fallback when the model is
 * unavailable — canned pre-session questions, a fixed set of activities, a
 * platform summary in place of a clinical briefing. That is a legitimate,
 * useful outcome, but it used to be completely invisible: the fallback was
 * returned in the same shape as model output, so a patient or a clinician had
 * no way to know whether they were reading something personalised or a
 * template. This renders that distinction.
 */
export default function AiSourceBadge({
    source,
    className = "",
}: {
    source?: AiSource;
    className?: string;
}) {
    if (!source) return null;

    if (source === "model") {
        return (
            <span
                className={`inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-bold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300 ${className}`}
            >
                <Bot className="h-3 w-3" aria-hidden="true" />
                Written by AI
            </span>
        );
    }

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300 ${className}`}
        >
            <ListChecks className="h-3 w-3" aria-hidden="true" />
            Standard guidance — not personalised
        </span>
    );
}
