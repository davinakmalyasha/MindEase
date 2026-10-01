import { describe, expect, it } from "vitest";
import enMessages from "@/messages/en.json";
import idMessages from "@/messages/id.json";

/**
 * Guards the two locale files against drift.
 *
 * They were hand-maintained in parallel, so nothing stopped a key being added
 * to `en.json` and forgotten in `id.json` (or renamed in one and not the
 * other). Either mistake surfaces at runtime as a raw key printed into the UI
 * — `dashboard.browseDoctors` rendered literally in the middle of an
 * otherwise Indonesian page — and only for the locale that was missed.
 *
 * The checks here are structural, not linguistic: this app has no machine
 * translation step, so correctness of the wording is a review matter. What is
 * enforceable is that both files describe the same set of keys with the same
 * shape and the same empty-value discipline.
 */

type Json = { [key: string]: string | Json };

/**
 * The JSON imports resolve to a concrete object type, which is not assignable
 * to an index signature, so the widening happens once here via `unknown` rather
 * than at every use site.
 */
const asJson = (value: unknown): Json => value as Json;

/** Flattens to dotted leaf paths, e.g. `dashboard.explore`. */
const leafPaths = (node: Json, prefix = ""): string[] =>
    Object.entries(node).flatMap(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === "string" ? [path] : leafPaths(value, path);
    });

/** `a.b` -> the value at that path. */
const valueAt = (node: Json, path: string): string | Json | undefined =>
    path.split(".").reduce<Json | string | undefined>(
        (acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined),
        node
    );

const en = asJson(enMessages);
const id = asJson(idMessages);

const enPaths = leafPaths(en);
const idPaths = leafPaths(id);

describe("locale files", () => {
    it("has a non-trivial number of keys", () => {
        expect(enPaths.length).toBeGreaterThan(100);
    });

    it("defines exactly the same keys in both locales", () => {
        const onlyEn = enPaths.filter((p) => !idPaths.includes(p));
        const onlyId = idPaths.filter((p) => !enPaths.includes(p));
        expect({ onlyEn, onlyId }).toEqual({ onlyEn: [], onlyId: [] });
    });

    it("has no empty strings in either locale", () => {
        const empty = [
            ...enPaths.filter((p) => (valueAt(en, p) as string).trim() === "").map((p) => `en:${p}`),
            ...idPaths.filter((p) => (valueAt(id, p) as string).trim() === "").map((p) => `id:${p}`),
        ];
        expect(empty).toEqual([]);
    });

    it("keeps ICU placeholders consistent across locales", () => {
        // A translator dropping `{name}` or renaming a placeholder would render
        // a literal `{name}` in the UI at runtime rather than failing a build.
        const placeholders = (value: string) =>
            (value.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();

        const mismatched = enPaths
            .map((path) => {
                const a = placeholders(valueAt(en, path) as string);
                const b = placeholders(valueAt(id, path) as string);
                return a.join(",") === b.join(",") ? null : { path, en: a, id: b };
            })
            .filter(Boolean);

        expect(mismatched).toEqual([]);
    });

    it("translates every string that is UI prose", () => {
        // Some values are legitimately identical between locales, so the check
        // is scoped rather than absolute:
        //
        //  - a brand name and a loanword;
        //  - crisis hotline data. Phone numbers, dial strings and the official
        //    names of the organisations behind them ("Halo Kemenkes",
        //    "Bebas Bicara", "Samaritans (UK & ROI)") must be byte-identical
        //    across locales — translating a number or an official service name
        //    would be a correctness bug, not an improvement. These 23 values
        //    are the entire set of identical strings today.
        //
        // Anything else matching between the files is untranslated prose, and
        // would render as English in the middle of an Indonesian page.
        //
        //  - "Status" and "Target" are listed because they are not English that
        //    leaked through: they are the Indonesian words as well, identically
        //    spelt. Translating them would mean inventing a synonym to satisfy
        //    a test, which makes the check less meaningful, not more.
const allowIdentical = new Set([
    "common.appName",
    "auth.email",
    "features.doctorProfile.credentialsStatusLabel",
    "features.carePlan.statusLabel",
    "features.carePlan.target",
    // "Minimal" is a clinical severity band on the triage screen, and it is the
    // Indonesian word too - the PHQ-9 and GAD-7 severity labels are borrowed
    // into Indonesian clinical usage unchanged. Same category as "Status" and
    // "Target" above, for the same reason.
    "features.riskQueue.severity_minimal",
]);
        const isHotlineData = (path: string) =>
            /^staticPages\.(crisis|offline)\.hotlines\.\d+\.(number|dial|contact|name)$/.test(path);

        const untranslated = enPaths
            .filter((p) => !allowIdentical.has(p) && !isHotlineData(p))
            .filter((p) => valueAt(en, p) === valueAt(id, p));

        expect(untranslated).toEqual([]);
    });
});
