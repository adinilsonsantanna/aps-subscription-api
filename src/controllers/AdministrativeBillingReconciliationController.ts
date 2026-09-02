import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { AdministrativeBillingReconciliationService, AdministrativeReconciliationError, ADMIN_RECONCILIATION_ACCEPTED_KEYS } from "../shopify/reconciliation/admin-billing-reconciliation";
import { keysFingerprint, unexpectedKeys } from "../shopify/reconciliation/keys-fingerprint";
import { sanitizedAdministrativeReconciliationPrismaError } from "../shopify/reconciliation/prisma-observability";

function safeCorrelationId(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).correlationId;
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(value) ? value : undefined;
}

export class AdministrativeBillingReconciliationController {
  constructor(
    private readonly service = new AdministrativeBillingReconciliationService(),
    private readonly logger: Pick<Console, "error"> = console,
  ) {}

  async execute(req: Request, res: Response) {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "invalid_payload" });
    if (req.body.dryRun !== true) return res.status(400).json({ error: "dry_run_required" });
    return this.run(req, res, false);
  }

  async executeLive(req: Request, res: Response) {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "invalid_payload" });
    if (req.body.dryRun !== false) return res.status(400).json({ error: "live_mode_required" });
    return this.run(req, res, true);
  }

  private async run(req: Request, res: Response, live: boolean) {
    const requestId = randomUUID();
    try {
      return res.json(await this.service.execute(req.body));
    } catch (error) {
      if (error instanceof AdministrativeReconciliationError) {
        if (error.code === "unexpected_field") {
          const correlationId = safeCorrelationId(req.body);
          this.logger.error("[Administrative reconciliation] Unexpected payload field", {
            event: live ? "administrative_reconciliation_live_unexpected_field" : "administrative_reconciliation_unexpected_field",
            requestId,
            unknownKeys: unexpectedKeys(req.body, ADMIN_RECONCILIATION_ACCEPTED_KEYS),
            keyCount: Object.keys(req.body ?? {}).length,
            fingerprint: keysFingerprint(req.body),
            ...(correlationId ? { correlationId } : {}),
          });
        }
        return res.status(error.statusCode).json({ error: error.code, requestId });
      }
      const prismaDiagnostics = sanitizedAdministrativeReconciliationPrismaError(error);
      if (prismaDiagnostics) {
        const correlationId = safeCorrelationId(req.body);
        this.logger.error("[Administrative reconciliation] Failed", {
          event: live ? "administrative_reconciliation_live_failed" : "administrative_reconciliation_failed",
          ...prismaDiagnostics,
          ...(correlationId ? { correlationId } : {}),
        });
      } else {
        this.logger.error("[Administrative reconciliation] Failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      }
      return res.status(500).json({ error: "administrative_reconciliation_failed" });
    }
  }
}
