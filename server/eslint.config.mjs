// ESLint flat config for the API.
//
// `npm run lint` fails on errors. Warnings are advisory and currently all come
// from `no-explicit-any`, which is 75 pre-existing annotations across files
// that touch Prisma results and Express request bodies. Lower
// `--max-warnings` in CI as they are converted, so the count can only fall.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "prisma/**", "public/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parserOptions: {
                project: false,
            },
        },
        rules: {
            // `/// <reference types="..." />` is how Express augments
            // `req.user` / `RequestHandler` with the authenticated user. There is
            // no import-style equivalent for a global type augmentation.
            "@typescript-eslint/triple-slash-reference": "off",

            // Explicit `any` on clinical payloads is worth seeing. Opt back in
            // per line with a justification where it is genuinely unavoidable.
            "@typescript-eslint/no-explicit-any": "warn",

            // Unused code is a real finding in this repo: there were dead
            // exports, an unreferenced service method, a `markBooked` nothing
            // called, and a helper whose "used by tests" comment was false.
            //
            // `ignoreRestSiblings` is required, not optional: the
            // destructure-and-discard in `toSafeUser` is how password hashes,
            // TOTP secrets and OTP digests are stripped before a user object
            // leaves the service. Those names are genuinely used — as removals.
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrors: "none",
                    ignoreRestSiblings: true,
                },
            ],

            // Notification, push, realtime and mail dispatch are deliberately
            // fire-and-forget so one failing channel cannot report a false
            // negative to a clinician. Flagging every one of those as an error
            // would just teach people to add `void`.
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-misused-promises": "off",

            eqeqeq: ["error", "always", { null: "ignore" }],
            "no-console": ["warn", { allow: ["warn", "error"] }],
        },
    },
    {
        // Tests legitimately use `require` to pull in modules after the database
        // is prepared, and drive the HTTP surface with looser typing.
        files: ["tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-require-imports": "off",
        },
    }
);
