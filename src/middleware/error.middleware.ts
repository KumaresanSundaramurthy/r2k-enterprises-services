import { Request, Response, NextFunction } from "express";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error(err);
  res.status(500).json({ message: err.message || "Internal server error" });
}
