import { describe, it, expect } from "vitest";
import { jsonLdScript } from "@/lib/jsonLd";

/**
 * The doctor profile renders a `MedicalBusiness` JSON-LD block on a public,
 * unauthenticated page, built from `name` and `specialty` - both entered by the
 * clinician. React can only emit that block through `dangerouslySetInnerHTML`,
 * so the serialiser is the whole of the defence.
 *
 * These cases are about the HTML tokenizer, not about JSON. A script element is
 * read in *script data* state, where `</script` ends the element no matter how
 * the surrounding bytes are quoted, so the question for each input is whether
 * the serialised output could terminate the element early.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe("jsonLdScript", () => {
    it("does not let a value close the script element", () => {
        const name = "</script><img src=x onerror=alert(1)>";
        const payload = jsonLdScript({ name });

        // The decoded value is still correct - the escaping is transport-only.
        expect(JSON.parse(payload).name).toBe(name);

        // But the bytes a browser tokenises contain no closing sequence and no
        // raw angle bracket, so the element cannot be terminated early.
        expect(payload).not.toContain("</script");
        expect(payload).not.toContain("<");
        expect(payload).not.toContain(">");
    });

    it("escapes every character the HTML tokenizer treats specially", () => {
        expect(jsonLdScript({ a: "<>&" })).toBe('{"a":"\\u003c\\u003e\\u0026"}');
    });

    it("catches a closing sequence with unusual casing and spacing", () => {
        const payload = jsonLdScript({ name: "</SCRIPT >", specialty: "x" });

        expect(payload.toLowerCase()).not.toContain("</script");
    });

    it("catches a payload split across separate fields", () => {
        const payload = jsonLdScript({ a: "</scr", b: "ipt>" });

        expect(payload.toLowerCase()).not.toContain("</script");
    });

    it("escapes the JSON-legal but JS-fatal line separators", () => {
        const name = `before${LINE_SEPARATOR}after${PARAGRAPH_SEPARATOR}end`;
        const payload = jsonLdScript({ name });

        expect(payload).not.toContain(LINE_SEPARATOR);
        expect(payload).not.toContain(PARAGRAPH_SEPARATOR);
        // Still valid JSON, and the value survives the round trip.
        expect(JSON.parse(payload).name).toBe(name);
    });

    it("leaves ordinary values readable", () => {
        const doctor = {
            "@type": "MedicalBusiness",
            name: "Dr. Sarah Mitchell",
            medicalSpecialty: "Clinical Psychologist",
            priceRange: "IDR 150.000",
        };

        expect(JSON.parse(jsonLdScript(doctor))).toEqual(doctor);
    });

    it("round-trips nested objects and arrays unchanged", () => {
        const value = {
            aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5, reviewCount: 12 },
            availableLanguage: ["en", "id"],
        };

        expect(JSON.parse(jsonLdScript(value))).toEqual(value);
    });
});
