import { Router } from "express";
import { adminLiveAuth } from "../middlewares/adminLiveAuth";
import { AdministrativeBillingReconciliationController } from "../controllers/AdministrativeBillingReconciliationController";
const router = Router(), controller = new AdministrativeBillingReconciliationController();
// O mount em routes/index.ts já aplica apiAuth (X-API-Key) + json no caminho
// /api/administrative-reconciliation.
// Dry-run administrativo: apenas autenticação da App.
router.post("/billing-attempt", controller.execute.bind(controller));
// Live administrativo: além da autenticação da App, exige secret server-to-server
// específico de live (X-Admin-Live-Key). O controller exige dryRun:false explícito.
router.post("/billing-attempt/live", adminLiveAuth, controller.executeLive.bind(controller));
export default router;
