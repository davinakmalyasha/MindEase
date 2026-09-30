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

/** Human label for a queue item's source, for the "why am I seeing this" column. */
export const SOURCE_LABEL: Record<string, string> = {
    phq9: "PHQ-9 screening",
    gad7: "GAD-7 screening",
    sos: "SOS button",
    message: "Message",
    mood: "Mood log",
};

export const riskErrorMessage = (err: unknown, fallback: string) => getErrorMessage(err, fallback);
