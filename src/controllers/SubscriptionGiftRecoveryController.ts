import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { GiftShopifyClient } from "../gifts/subscription-gift.shopify.client";

const ALLOWED_JOB_ID = "cmu5q5t5e0003jw04zv6faoqy";
const GIFT_VARIANT_ID = "gid://shopify/ProductVariant/53775084388715";

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  const received = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(expected) && Buffer.byteLength(expected) === Buffer.byteLength(received) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export class SubscriptionGiftRecoveryController {
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly shopify = new GiftShopifyClient(),
  ) {}

  async run(request: Request, response: Response) {
    try {
      if (!authorized(request)) return response.status(401).json({ error: "unauthorized" });
      const jobId = typeof request.query.jobId === "string" ? request.query.jobId : "";
      if (jobId !== ALLOWED_JOB_ID) return response.status(404).json({ error: "recovery_not_found" });

    const job = await this.prisma.subscriptionGiftJob.findUnique({
      where: { id: ALLOWED_JOB_ID },
      include: { shop: { select: { domain: true, accessToken: true } } },
    });
    if (!job) return response.status(404).json({ error: "job_not_found" });
    if (job.status === "COMMITTED" && job.resultCode === "recovered_from_commit_pending") {
      return response.status(200).json({ success: true, idempotent: true, status: job.status, processedAt: job.processedAt });
    }
    if (job.status !== "COMMIT_PENDING") return response.status(409).json({ error: "job_not_commit_pending", status: job.status });

    const lines = await this.shopify.queryOrderGiftLines(job.shop.domain, job.shop.accessToken, job.orderId, GIFT_VARIANT_ID);
    const hasPaidLine = lines.some((line) => line.discountedUnitPrice > 0);
    const freeLine = lines.find((line) => line.discountedUnitPrice === 0);
    if (!hasPaidLine || !freeLine) return response.status(409).json({ error: "gift_lines_not_confirmed" });

    const processedAt = new Date();
    const claimed = await this.prisma.subscriptionGiftJob.updateMany({
      where: { id: ALLOWED_JOB_ID, status: "COMMIT_PENDING" },
      data: {
        status: "COMMITTED",
        resultCode: "recovered_from_commit_pending",
        resultMessage: `Recovery idempotente confirmou linha gratuita existente: ${freeLine.title}.`,
        giftLineIdentifier: freeLine.lineId,
        processedAt,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.subscriptionGiftJob.findUnique({ where: { id: ALLOWED_JOB_ID }, select: { status: true, processedAt: true, resultCode: true } });
      return response.status(200).json({ success: current?.status === "COMMITTED", idempotent: true, ...current });
    }
      return response.status(200).json({ success: true, idempotent: false, status: "COMMITTED", processedAt, resultCode: "recovered_from_commit_pending" });
    } catch {
      return response.status(502).json({ error: "recovery_confirmation_failed" });
    }
  }
}
