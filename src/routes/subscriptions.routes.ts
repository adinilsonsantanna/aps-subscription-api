import { Router } from "express";
import { SubscriptionController } from "../controllers/SubscriptionController";

const router = Router();
const controller = new SubscriptionController();

router.post("/:id/pause", controller.lifecycleAction.bind(controller));
router.post("/:id/resume", controller.lifecycleAction.bind(controller));
router.post("/:id/cancel", controller.lifecycleAction.bind(controller));

router.get("/:domain", controller.listByShop.bind(controller));
router.post("/", controller.create.bind(controller));
router.get("/detail/:id", controller.getById.bind(controller));
router.patch("/:id/status", controller.updateStatus.bind(controller));

export default router;
