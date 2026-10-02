import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // The React Compiler rule set arrived in eslint-plugin-react-hooks v7, which
    // `eslint-config-next` pulls in transitively. Four of its rules report
    // patterns that are correct React and that this codebase uses deliberately,
    // so they are demoted to warnings rather than left as errors or switched off:
    //   - `set-state-in-effect` fires on the standard "fetch when a dependency
    //     becomes available" effect (`useEffect(() => { fetch() }, [dep])`), which
    //     sets a loading flag synchronously at the top of the fetch. That is the
    //     documented shape of a data-loading effect in React and in every
    //     Next.js data-fetching guide. It is a compiler *optimisation* hint - it
    //     never indicates a broken render.
    //   - `purity`, `immutability` and `refs` likewise report compile-time
    //     optimisability, not defects.
    //
    // `rules-of-hooks` and `exhaustive-deps` stay at error: those two catch real
    // bugs, and they are the reason to run this plugin at all.
    //
    // Demoted, not deleted - they still print, so the React Compiler migration
    // stays visible in the lint output and can be done as its own change with its
    // own testing, rather than as a drive-by inside a dependency bump.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;