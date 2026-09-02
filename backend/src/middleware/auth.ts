// @ts-nocheck
import { Request, Response, NextFunction } from "express";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Disabling login requirement as requested
  res.locals.userId = "00000000-0000-0000-0000-000000000000";
  res.locals.userEmail = "user@example.com";
  res.locals.token = "dummy-token";
  next();
}
