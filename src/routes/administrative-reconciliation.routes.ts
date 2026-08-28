import { Router } from "express";
import { AdministrativeBillingReconciliationController } from "../controllers/AdministrativeBillingReconciliationController";
const router = Router(), controller = new AdministrativeBillingReconciliationController();
router.post("/billing-attempt", controller.execute.bind(controller));
export default router;
