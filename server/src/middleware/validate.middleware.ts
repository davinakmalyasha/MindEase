import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";

export const validate = (schema: ZodSchema) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                const issues = error.issues || [];
                return res.status(400).json({
                    status: "error",
                    message: issues.length > 0 ? issues[0].message : "Validation Error",
                    errors: issues.map((e: any) => ({
                        path: e.path.join("."),
                        message: e.message,
                    })),
                });
            }
            next(error);
        }
    };
};
