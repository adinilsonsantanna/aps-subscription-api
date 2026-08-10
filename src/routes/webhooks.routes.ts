import { Router } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

router.post("/shopify", controller.shopify.bind(controller));
router.post("/stripe", controller.stripe.bind(controller));

export default router;