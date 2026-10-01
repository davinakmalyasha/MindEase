import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import api, { getErrorMessage } from "@/lib/api";

/**
 * The clinician triage queue.
 *
 * `risk:alert` was dispatched by the realtime fanout and had no listener
 * anywhere in the client. A PHQ-9 item 9 disclosure, an SOS press, or a crisis
 * phrase in a message produced a server frame that reached the browser and
 * died. This hook is the consumer that makes it mean something, and it also
 * invalidates the queue on an incoming alert so a clinician looking at an open
 * list sees the new item without pressing anything.
 */

export const riskQueueKeys = {
    all: ["risk-alerts"] as const,
    list: (includeResolved: boolean) => ["risk-alerts", "list", { includeResolved }] as const,
};

export interface RiskQueueCounts {
    unresolved: number;
    unacknowledged: number;
    urgentUnacknowledged: number;
}

export interface RiskQueueItem {
    id: number;
    priority: 0 | 1 | 2 | 3;
    urgency: string;
    level: string;
    reason: string;
    sourceType: string;
    sourceId: number | null;
    createdAt: string;
    acknowledgedAt: string | null;
    resolutionNote: string | null;
    resolvedAt: string | null;
    patient: {
        id: number;
        name: string | null;
        email: string | null;
        lastAssessment: {
            type: string;
            score: number;
            severity: string;
            createdAt: string;
        } | null;
    };
}

const read = async (includeResolved: boolean) => {
    const res = await api.get(
        `/wellness/risk-alerts${includeResolved ? "?includeResolved=true" : ""}`
    );
    return {
        items: (res.data?.data ?? []) as RiskQueueItem[],
        counts: (res.data?.counts ?? {
            unresolved: 0,
            unacknowledged: 0,
            urgentUnacknowledged: 0,
        }) as RiskQueueCounts,
    };
};

export const useRiskQueue = (includeResolved = false) =>
    useQuery({
        queryKey: riskQueueKeys.list(includeResolved),
        queryFn: () => read(includeResolved),
        // A triage queue that refetches on window focus is a triage queue that
        // reorders under the cursor. Ten seconds is enough to feel live without
        // moving an item a clinician is about to click.
        refetchInterval: 10_000,
        staleTime: 5_000,
    });

export const useAcknowledgeRisk = () => {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: number) => {
            const res = await api.post(`/wellness/risk-alerts/${id}/acknowledge`);
            return res.data?.data;
        },
        // Invalidate rather than patch: acknowledging does not remove the item
        // (it is still unresolved), it reorders it and decrements a count. Both
        // are derived server-side, so a client-side guess would drift.
        onSuccess: () => qc.invalidateQueries({ queryKey: riskQueueKeys.all }),
    });
};

export const useResolveRisk = () => {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, note }: { id: number; note?: string }) => {
            const res = await api.post(`/wellness/risk-alerts/${id}/resolve`, { note });
            return res.data?.data;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: riskQueueKeys.all }),
    });
};

/**
 * Subscribes to `realtime:risk-alert`.
 *
 * Mounted once from the risk queue page rather than globally. The nav badge
 * reads the same cache, so a clinician on the queue sees the arrival and a
 * clinician elsewhere sees the count change on their next fetch - without
 * opening a socket for a user who can never see the queue.
 *
 * Dispatches a window event as well as invalidating, so the page can toast
 * rather than silently rearranging under someone.
 */
export const useRiskAlertListener = (onAlert?: (payload: unknown) => void) => {
    const qc = useQueryClient();

    useEffect(() => {
        const handler = (event: Event) => {
            qc.invalidateQueries({ queryKey: riskQueueKeys.all });
            onAlert?.((event as CustomEvent).detail);
        };
        window.addEventListener("realtime:risk-alert", handler);
        return () => window.removeEventListener("realtime:risk-alert", handler);
    }, [qc, onAlert]);
};

/**
 * Translation key suffix per disclosure source, looked up as `source_<x>` in
 * `features.riskQueue`.
 *
 * This was a hardcoded English `Record<string, string>` rendered as the "why am
 * I seeing this" column on the triage screen, so a clinician using Indonesian
 * read "PHQ-9 screening" on an otherwise translated page. The values now live in
 * the locale files, where the parity test holds both sides to the same key set.
 */
export const SOURCE_KEY: Record<string, string> = {
    phq9: "source_phq9",
    gad7: "source_gad7",
    sos: "source_sos",
    message: "source_message",
    mood: "source_mood",
};

/**
 * A clinical severity slug from the API, as a translation key suffix.
 *
 * The server sends "moderately-severe" and the raw slug used to be rendered
 * directly, putting a hyphenated API value in front of a clinician on the
 * triage screen.
 */
export const SEVERITY_KEY: Record<string, string> = {
    minimal: "severity_minimal",
    mild: "severity_mild",
    moderate: "severity_moderate",
    "moderately-severe": "severity_moderatelySevere",
    severe: "severity_severe",
};

export const riskErrorMessage = (err: unknown, fallback: string) => getErrorMessage(err, fallback);
