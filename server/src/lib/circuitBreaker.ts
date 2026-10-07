/**
 * A minimal three-state circuit breaker.
 *
 * Motivation: every AI feature degrades to a deterministic local fallback when
 * the model is unreachable, which is correct behaviour — but without a breaker
 * the failure is paid in full on *every* request. If Gemini hangs for its
 * default timeout, each user waits that entire timeout before seeing the
 * fallback, and the process holds an open Express handler for the duration. A
 * handful of concurrent requests then multiply the load on an upstream that is
 * already struggling, which is how a slow dependency becomes an outage.
 *
 * States:
 *   closed    — normal. Failures accumulate.
 *   open      — refusing calls without touching the dependency. Entered after
 *               `threshold` consecutive failures, held for `cooldownMs`.
 *   half-open — cooldown elapsed; calls are allowed through as probes. A
 *               success closes the circuit, a failure re-opens it for another
 *               cooldown. Probes are not single-flight: a burst may get through
 *               together, which is acceptable here because the alternative is
 *               adding cross-process coordination to a purely local optimisation.
 *
 * This is deliberately per-process. A multi-replica deployment gives each
 * replica its own breaker, so the fleet as a whole makes at most
 * (replicas) probes per cooldown — a deliberate, bounded overshoot rather than
 * a coordinated thundering herd, and far cheaper than a shared store.
 */
export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
    private consecutiveFailures = 0;
    /** When the circuit opened, or null while closed. */
    private openedAt: number | null = null;

    constructor(
        private readonly threshold: number,
        private readonly cooldownMs: number,
        /** Injected clock, so the cooldown is testable without sleeping. */
        private readonly now: () => number = () => Date.now()
    ) {}

    /**
     * Current state. Reading this transitions the breaker, so callers must use
     * the result they get rather than re-reading it.
     */
    get state(): BreakerState {
        if (this.openedAt === null) return "closed";
        return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
    }

    /** True when a call should be refused without touching the dependency. */
    get isOpen(): boolean {
        return this.state === "open";
    }

    recordSuccess(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
    }

    recordFailure(): void {
        this.consecutiveFailures++;
        // Re-arming on a failed probe is what keeps a half-open circuit from
        // flapping back to closed on the next unrelated success.
        if (this.consecutiveFailures >= this.threshold) {
            this.openedAt = this.now();
        }
    }

    /** Test/ops affordance: return to the initial state. */
    reset(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
    }
}
