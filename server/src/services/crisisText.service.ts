/**
 * Deterministic detection of a crisis disclosure in free text.
 *
 * This is a keyword matcher and that is the point. Three properties matter more
 * than recall:
 *
 * 1. **It never leaves the server.** The alternative - asking a model whether a
 *    message is a crisis - means the most sensitive text a patient can write is
 *    sent to a third-party processor, and that a refusal, a timeout or a
 *    degraded upstream response can silently withhold a safety signal. A regex
 *    cannot be unavailable.
 *
 * 2. **It is auditable.** A clinician being paged can be told exactly which
 *    pattern matched. "A model flagged this" is not reviewable; `/want to
 *    die/i matched` is.
 *
 * 3. **It is predictable under review.** A matcher that changes behaviour when
 *    a provider ships a new model version cannot be reasoned about in a
 *    clinical context.
 *
 * The cost is false positives. "I want to kill this game" matches. That is
 * acceptable *only* because a match is a prompt for a human to look, never an
 * action: nothing is auto-escalated to an emergency service, no clinician is
 * blocked, and the alert is labelled a heuristic in the queue. The asymmetry is
 * deliberate - a false positive costs a clinician thirty seconds, a false
 * negative can cost a life.
 *
 * Patterns live here and are re-exported to `support.service`, so the support
 * bot and the message path cannot disagree about what counts as a crisis.
 */
import type { RiskLevel } from "./clinicalSafety.service";

/**
 * Bounded to the phrases a person actually uses to describe harming themselves.
 *
 * Two things are deliberately absent. Euphemisms like "not be here anymore" are
 * omitted: they are far too common in ordinary context to page anyone over, and
 * adding them would bury the real signals in noise. And so is any negation
 * handling - "I don't want to die" contains a crisis phrase, and attempting to
 * distinguish it from the affirmative reliably needs semantics a regex does not
 * have. The match is a review prompt, so the cost of over-matching is low
 * enough that pretending to be clever here would be the worse trade.
 *
 * Indonesian is included because it is a first-language locale for this
 * product, and a crisis channel that only works in English is not a crisis
 * channel.
 */
export const CRISIS_PATTERNS: readonly RegExp[] = [
    /suicid(e|al|ally)/i,
    /kill(ing)? myself/i,
    /end(ing)? my life/i,
    /want(ing)? to die/i,
    /don'?t want to (be here|live|go on)/i,
    /self[\s-]?harm/i,
    /hurt(ing)? myself/i,
    /harm(ing)? myself/i,
    /overdos(e|ing)/i,
    /bunuh diri/i,
    /mengakhiri hidup/i,
    /mau ingin mati/i,
    /ingin mati/i,
    /menyakiti diri/i,
    /sakiti diri/i,
];

/**
 * Statements that mention someone else.
 *
 * This used to *suppress* the alert. It does not any more, and the reason is
 * worth writing down because the previous version read as though it were
 * obviously correct.
 *
 * The suppression was applied to the whole message, before any crisis pattern
 * was tried. So "My husband has been so supportive and I want to die" matched
 * `my husband`, returned null, and no clinician was ever paged — for what is
 * close to a textbook first-person disclosure, and arguably *more* likely than
 * a bare one, because a person who has just described their support network is
 * a person reaching out.
 *
 * A regex cannot separate "my brother attempted suicide" from "my brother is
 * supportive and I want to die". Both contain `my brother` and both contain a
 * crisis phrase. Only one of them is about the patient.
 *
 * So the signal is kept, and its role changes: it no longer decides whether to
 * page, it decides what the clinician is told. The alert is raised, and the note
 * says the message also mentions a third party, so the person reading the queue
 * has the context that the original author was trying to give them. That is the
 * correct division of labour for a heuristic whose stated failure mode is "a
 * false positive costs a clinician thirty seconds".
 */
const THIRD_PARTY = /\b(my (friend|brother|sister|partner|husband|wife|son|daughter|mother|father|roommate|colleague|coworker|boss))\b/i;

export interface FreeTextRisk {
    matched: true;
    level: RiskLevel;
    /** The phrase that matched, for the clinician to verify. */
    matchedText: string;
    reason: string;
    /**
     * True when the message also names a third party. Purely informational: it
     * never suppresses the alert, but a clinician deciding whether a disclosure
     * is about the patient benefits from knowing the answer was already on the
     * page.
     */
    mentionsThirdParty: boolean;
}

export type FreeTextRiskResult = FreeTextRisk | null;

/**
 * Classifies a message.
 *
 * Returns null only when no crisis phrase is present at all. A third-party
 * mention does not make a message safe — see the note on `THIRD_PARTY` above for
 * the concrete disclosure this used to swallow.
 */
export const detectFreeTextRisk = (content: string): FreeTextRiskResult => {
    if (!content) return null;

    for (const pattern of CRISIS_PATTERNS) {
        const match = content.match(pattern);
        if (!match) continue;

        // Every one of these phrases implies the act is contemplated or
        // occurring, not merely that the topic arose. There is no "low
        // confidence" tier to design around: a phrase either matches or it does
        // not, and a clinician decides what it means.
        const mentionsThirdParty = THIRD_PARTY.test(content);
        const context = mentionsThirdParty
            ? " The message also mentions another person, so it may partly be about them rather than about the patient; the clinician decides which."
            : "";

        return {
            matched: true,
            level: "urgent",
            matchedText: match[0],
            mentionsThirdParty,
            reason: `Free-text message matched the crisis pattern "${match[0]}". This is a keyword match, not a clinical assessment - it is a prompt for a clinician to read the message and decide.${context}`,
        };
    }

    return null;
};
