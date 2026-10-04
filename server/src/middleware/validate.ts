import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny } from "zod";

// ── Zod request validation (both body & query) ──────────────────────────────
interface ValidateOptions {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ValidateOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        (req as Request & { parsedQuery?: unknown }).parsedQuery = parsed;
      }
      if (schemas.params) {
        const parsed = schemas.params.parse(req.params);
        (req as Request & { parsedParams?: unknown }).parsedParams = parsed;
      }
      next();
    } catch (e) {
      const issues = (e as { issues?: Array<{ path?: Array<string | number>; message: string }> }).issues;
      const first = issues?.[0];
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: first?.message ?? "The request data is invalid.",
          details: issues,
        },
      });
    }
  };
}
