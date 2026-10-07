/**
 * JSON-LD cannot be passed to React as a prop.
 *
 * A `<script type="application/ld+json">` has to be rendered with
 * `dangerouslySetInnerHTML`, because its content is not JavaScript and must not
 * be executed or escaped as such. That makes the serialiser the only thing
 * standing between a user-supplied string and the parser.
 *
 * `JSON.stringify` is not sufficient here. It escapes quotes and control
 * characters, which is all a *JavaScript* string literal needs, but it leaves
 * `<`, `>` and `&` untouched. The HTML tokenizer is not parsing JavaScript when
 * it reads a script element - it is in script data state, where the sequence
 * `</script` ends the element regardless of any quoting. So a value containing
 * that sequence terminates the script early, and everything after it is parsed
 * as markup by the browser.
 *
 * That is reachable here. `name` and `specialty` are entered by a clinician at
 * registration and rendered into the structured data on the public,
 * unauthenticated profile page.
 *
 * Escaping the characters that matter makes `</script` unrepresentable in the
 * output while leaving the decoded value byte-identical: JSON parses the escapes
 * back to the original characters, so consumers of the structured data see
 * exactly what went in.
 */

// Built with fromCharCode rather than written as literals or as escapes.
// U+2028 and U+2029 are invisible in an editor and in a diff, and enough tools
// normalise them out of a source file that a literal here would silently become
// a plain space, leaving a hole in the character class with nothing to show for
// it. 0x2028 is LINE SEPARATOR and 0x2029 is PARAGRAPH SEPARATOR: both are legal
// inside a JSON string, but both are line terminators to a JavaScript parser, so
// an inline script containing one is a syntax error.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const UNSAFE: Readonly<Record<string, string>> = {
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    [LINE_SEPARATOR]: "\\u2028",
    [PARAGRAPH_SEPARATOR]: "\\u2029",
};

// Built by iterating the object rather than written as a character class, for
// the same reason: a literal class is where the invisible characters go wrong.
//
// No `UNSAFE_CHARS` join is exported: the serialiser below iterates the object
// directly, so the joined string had no reader. A constant that nothing reads is
// a constant that can drift out of step with the thing it was derived from, and
// this one would have failed silently - the escaping would still have been
// correct, because the code did not use it.

/** Serialises `value` for embedding inside a `<script>` element. */
export function jsonLdScript(value: unknown): string {
    const json = JSON.stringify(value);

    let out = "";
    for (const char of json) {
        out += UNSAFE[char] ?? char;
    }
    return out;
}
