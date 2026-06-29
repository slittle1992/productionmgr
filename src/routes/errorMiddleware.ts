import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { BuilderPrimeError } from "../builderPrime/client.js";

/**
 * Central error handler. Validation problems become 400s with field detail;
 * Builder Prime failures surface only the safe `userMessage` (§7.5); anything
 * else becomes a generic 500. Raw upstream errors are never sent to the phone.
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation_error",
      message: "Please check the highlighted fields.",
      issues: err.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  if (err instanceof BuilderPrimeError) {
    // 401 from upstream → 502 (our key is bad), everything else → 503-ish.
    const status = err.code === "API_UNAUTHORIZED" ? 502 : 503;
    res.status(status).json({
      error: "builder_prime_unavailable",
      message: err.userMessage,
    });
    return;
  }

  console.error("[unhandled]", err);
  res.status(500).json({
    error: "internal_error",
    message: "Something went wrong. Please try again.",
  });
}
