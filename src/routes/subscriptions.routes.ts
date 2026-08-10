import { Router } from "express";
import { SubscriptionController } from "../controllers/SubscriptionController";

const router = Router();
const controller = new SubscriptionController();

router.get("/:domain", controller.listByShop.bind(controller));
router.post("/", controller.create.bind(controller));
router.get("/detail/:id", controller.getById.bind(controller));
router.patch("/:id/status", controller.updateStatus.bind(controller));
router.delete("/:id", controller.cancel.bind(controller));

export default router;