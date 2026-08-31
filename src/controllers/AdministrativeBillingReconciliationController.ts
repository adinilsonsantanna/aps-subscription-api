import type { Request, Response } from "express";
import { AdministrativeBillingReconciliationService, AdministrativeReconciliationError } from "../shopify/reconciliation/admin-billing-reconciliation";
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
    try {
      return res.json(await this.service.execute(req.body));
    } catch (error) {
      if (error instanceof AdministrativeReconciliationError) return res.status(error.statusCode).json({ error: error.code });
      const prismaDiagnostics = sanitizedAdministrativeReconciliationPrismaError(error);
      if (prismaDiagnostics) {
        const correlationId = safeCorrelationId(req.body);
        this.logger.error("[Administrative reconciliation] Failed", {
          event: "administrative_reconciliation_failed",
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
