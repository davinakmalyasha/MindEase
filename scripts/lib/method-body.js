const fs = require("fs");
const path = require("path");

/**
 * The source of one static class member, from its signature to its closing brace.
 *
 * ## Why this is shared rather than copied
 *
 * Three gates need to ask "what does this method do", and each had its own copy
 * of a brace-matching extractor. Every copy was wrong in a different way, and
 * fixing one left the others wrong:
 *
 *   1. It took the first `{` after the method name. That lands inside a
 *      default-value object literal in the parameter list -
 *      `listQueue(actor, options = {})` - so three correctly instrumented methods
 *      were reported as uninstrumented.
 *   2. Fixed for that, it took the first brace after the parameter list that was
 *      followed by a line break. That handles `Promise<{ a; b }>` on one line but
 *      not a return type formatted across lines, where the type's own `{` *is*
 *      followed by a line break - so `resolve(): Promise<{\n resolvedAt ... }>`
 *      was read as a body that stopped at the end of the type. The gate silently
 *      missed a real defect because of it.
 *   3. The CRLF variant required exactly `\n` after the brace, so in a Windows
 *      checkout every method looked like it had no body.
 *
 * A fourth copy would be a fourth bug. Parsing TypeScript well needs a parser,
 * and this is not one - but a single shared approximation with a comment listing
 * what it does not handle is better than three that disagree.
 *
 * ## The approximation
 *
 * From the signature to the first line consisting of the closing brace at the
 * member's own indentation (four spaces in this codebase, two per nesting level).
 * Nested blocks are indented further, so they cannot match. A multi-line string
 * or template literal inside a method that contains a line of exactly `    }`
 * would end the extraction early; none of the members these gates inspect
 * contains one, and the assertions fail loudly rather than silently if that
 * changes.
 *
 * It returns the *signature and body*, including any return-type annotation. For
 * "does this method contain a prisma call with a conditional where", that is the
 * right span: the annotation holds no calls, and stopping at the next member
 * means another method's calls can never satisfy the check.
 */
function methodBody(src, name) {
    const start = src.search(new RegExp(`static\\s+(async\\s+)?${name}\\s*\\(`));
    if (start === -1) return null;

    // Find the end of the parameter list first, so a brace inside a default value
    // cannot be mistaken for anything.
    const paren = src.indexOf("(", start);
    if (paren === -1) return null;
    let depth = 0;
    let closeParen = -1;
    for (let i = paren; i < src.length; i += 1) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") {
            depth -= 1;
            if (depth === 0) {
                closeParen = i;
                break;
            }
        }
    }
    if (closeParen === -1) return null;

    // The member's closing brace, at its own indentation.
    //
    // The character after it must not be `>`, because a return type formatted
    // across lines ends with a line of exactly `    }>` - which begins with
    // `\n    }` and would otherwise be taken for the end of the body, giving a
    // span that excludes everything the method actually does. That is the same
    // mistake as taking the type's opening brace for the body's, from the other
    // end, and it is why this check is explicit rather than a bare `indexOf`.
    const terminator = `\n    }`;
    let end = -1;
    for (let at = src.indexOf(terminator, closeParen); at !== -1; at = src.indexOf(terminator, at + 1)) {
        const after = src[at + terminator.length];
        if (after !== ">") {
            end = at;
            break;
        }
    }
    if (end === -1) return null;

    return src.slice(start, end + terminator.length);
}

/**
 * Runs a gate in a temporary directory that contains a `scripts/lib/` alongside
 * the gate itself, so the shared helper resolves the same way it does in the
 * repository. Each self-test needs this; it lives here so the three of them
 * cannot drift on how they stage the tree.
 */
function stageGate(gatePath, dir) {
    const target = path.join(dir, "scripts");
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(gatePath, path.join(target, path.basename(gatePath)));
    fs.mkdirSync(path.join(target, "lib"), { recursive: true });
    fs.copyFileSync(
        path.join(__dirname, "method-body.js"),
        path.join(target, "lib", "method-body.js")
    );
}

module.exports = { methodBody, stageGate };
