import { timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { RetryEngineService } from "../retry/RetryEngineService";
export class RetryCronController {
  constructor(private engine = new RetryEngineService()) {}
  async run(req: Request, res: Response) {
    const expected = process.env.CRON_SECRET || "", received = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const valid = expected && Buffer.byteLength(expected) === Buffer.byteLength(received) && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!valid) return res.status(401).json({ error: "unauthorized" });
    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
    return res.json(await this.engine.run(limit));
  }
}
