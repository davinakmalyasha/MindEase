import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The login form must not be able to leak a password into a URL.
 *
 * ## The bug
 *
 * The sign-in form carried no `method` and no pre-hydration guard. Until React
 * hydrates, a click on the submit button is not a React event - it is a native
 * form submission, and the browser serialises every field into the query string:
 *
 *     /login?email=patient%40mindease.app&password=Patient%40123
 *
 * The password then lives in the address bar, in browser history, in any proxy
 * or CDN log on the path, and in the `Referer` header of every request the page
 * goes on to make. It is the worst possible place for a credential, and it
 * happens on a page that looks like it simply did not respond.
 *
 * It is not hypothetical: the first run of `client/scripts/screenshots.js`
 * produced exactly that URL, because the click landed before hydration on an
 * already-loaded page.
 *
 * ## Why this is a source-level test
 *
 * The property is not observable from jsdom without mounting the whole provider
 * tree and racing a hydration boundary, which would be a brittle test of a
 * timing behaviour. What matters is that both defences are present in the
 * source: the form cannot put fields in a query string, and the button cannot be
 * clicked before the handler exists.
 */
describe("login form cannot leak credentials into the URL", () => {
  const src = readFileSync(join(__dirname, "..", "app", "login", "page.tsx"), "utf8");

  it("gives every credential form a method, so a native submit does not use the query string", () => {
    const forms = src.match(/<motion\.form/g) || [];
    expect(forms.length).toBe(2);

    // Each `<motion.form` must be followed by a method attribute before its
    // closing `>`. Checking every form rather than the first: the registration
    // form takes a password too, and it was equally exposed.
    for (const match of src.matchAll(/<motion\.form[\s\S]*?>/g)) {
      const openTag = match[0];
      expect(openTag, "a form has no method attribute").toMatch(/method="post"/);
      expect(openTag, "a form has no onSubmit handler").toMatch(/onSubmit=/);
    }
  });

  it("disables both submit buttons until the component has hydrated", () => {
    // `disabled={isLoading}` alone was the original: true while a request is in
    // flight, false before hydration - which is precisely the window the native
    // submission fits into.
    expect(src).not.toMatch(/disabled=\{isLoading\}/);
    expect(src).not.toMatch(/disabled=\{isLoading \| isHydrated\}/);

    const hydrated = src.match(/disabled=\{isLoading \|\| !isHydrated\}/g) || [];
    expect(hydrated.length).toBe(2);

    // And the flag has to exist and be set from an effect, not just referenced.
    expect(src).toMatch(/const \[isHydrated, setIsHydrated\] = useState\(false\)/);
    expect(src).toMatch(/useEffect\(\(\) => setIsHydrated\(true\)/);
  });

  it("does not read credentials from the query string", () => {
    // Reading `?email=` back into the form would undo all of the above.
    expect(src).not.toMatch(/searchParams\.get\(["']email["']\)/);
    expect(src).not.toMatch(/searchParams\.get\(["']password["']\)/);
  });
});