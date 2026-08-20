import { Router } from "express";
import { RetrySettingsController } from "../controllers/RetrySettingsController";
const router = Router();
const controller = new RetrySettingsController();
router.get("/:shop", controller.get.bind(controller));
router.put("/:shop", controller.put.bind(controller));
export default router;
