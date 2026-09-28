import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";

/**
 * Express 5 defines `req.query` as a getter-only property on the request
 * object, so a plain assignment throws in strict mode. Redefine the property
 * rather than shadowing it.
 */
const replace = (target: object, key: string, value: unknown) => {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
};

/**
 * Validates the request and replaces it with the parsed result.
 *
 * Writing the parsed value back is what makes validation meaningful: Zod
 * strips unknown keys, applies defaults and coerces types, and all three only
 * take effect on the output. Parsing and then discarding the result — as this
 * middleware used to — silently left every one of those protections off while
 * still rejecting genuinely invalid input.
 */
export const validate = (schema: ZodSchema) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            // Express leaves `req.body` undefined when no body parser matched
            // (no Content-Type, or an empty payload). Every body schema here is
            // an object schema, so an absent body is validated as `{}` — which
            // correctly fails when fields are required and correctly passes when
            // they are all optional, instead of producing a confusing
            // "expected object, received undefined" for a body-less POST.
            const parsed = (await schema.parseAsync({
                body: req.body ?? {},
                query: req.query,
                params: req.params,
            })) as { body?: unknown; query?: unknown; params?: unknown };

            if (parsed.body !== undefined) replace(req, "body", parsed.body);
            if (parsed.query !== undefined) replace(req, "query", parsed.query);
            if (parsed.params !== undefined) replace(req, "params", parsed.params);

            next();
        } catch (error) {
            if (error instanceof ZodError) {
                const issues = error.issues || [];
                return res.status(400).json({
                    status: "error",
                    message: issues.length > 0 ? issues[0].message : "Validation Error",
                    errors: issues.map((e) => ({
                        path: e.path.join("."),
                        message: e.message,
                    })),
                });
            }
            next(error);
        }
    };
};
