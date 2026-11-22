import "reflect-metadata";
import dotenv from "dotenv";
dotenv.config();

import type { IncomingMessage, ServerResponse } from "http";
import { createApp } from "./app.factory";

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

// Vercel entry point. The Nest app is created once per function instance and reused by warm invocations.
let listener: Promise<RequestListener> | null = null;

async function getListener(): Promise<RequestListener> {
  const app = await createApp();
  await app.init();
  return app.getHttpAdapter().getInstance() as RequestListener;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!listener) {
    listener = getListener().catch((err: unknown) => {
      listener = null;
      return Promise.reject(err);
    });
  }
  try {
    const handle = await listener;
    handle(req, res);
  } catch (err: unknown) {
    console.error("App init failed:", err instanceof Error ? err.stack ?? err.message : String(err));
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Service temporarily unavailable. Please try again." }));
    }
  }
}
