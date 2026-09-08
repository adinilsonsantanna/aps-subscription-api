import { Router } from "express";
import { SubscriptionGiftController } from "../controllers/SubscriptionGiftController";
const router = Router();
const controller = new SubscriptionGiftController();
router.get("/settings/:shop", controller.getSettings.bind(controller));
router.put("/settings/:shop", controller.saveSettings.bind(controller));
router.get("/history/:shop", controller.history.bind(controller));
router.get("/:shop/process", controller.processShop.bind(controller));
export default router;