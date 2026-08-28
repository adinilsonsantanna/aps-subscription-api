import type { Request, Response } from "express";
import { AdministrativeBillingReconciliationService, AdministrativeReconciliationError } from "../shopify/reconciliation/admin-billing-reconciliation";
export class AdministrativeBillingReconciliationController {
  constructor(private readonly service = new AdministrativeBillingReconciliationService()) {}
  async execute(req: Request, res: Response) { try { return res.json(await this.service.execute(req.body)); } catch (error) { if (error instanceof AdministrativeReconciliationError) return res.status(error.statusCode).json({ error: error.code }); console.error("[Administrative reconciliation] Failed", { errorType: error instanceof Error ? error.name : "UnknownError" }); return res.status(500).json({ error: "administrative_reconciliation_failed" }); } }
}
