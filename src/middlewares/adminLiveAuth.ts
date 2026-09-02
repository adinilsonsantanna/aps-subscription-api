import type { NextFunction, Request, Response } from "express";
import { secureApiKeyMatches } from "./apiAuth";

// Camada adicional server-to-server. O segredo nunca é enviado ao navegador.
export function adminLiveAuth(req: Request, res: Response, next: NextFunction) {
  const liveKey = req.headers["x-admin-live-key"] as string | undefined;
  const expected = process.env.ADMIN_RECONCILIATION_LIVE_SECRET;
  if (!expected || !secureApiKeyMatches(liveKey, expected)) {
    return res.status(403).json({ error: "live_authorization_required" });
  }
  next();
}
