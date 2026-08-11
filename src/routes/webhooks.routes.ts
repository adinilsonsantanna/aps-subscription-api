import { Router } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

// Shopify: usa JSON normal
router.post("/shopify", controller.shopify.bind(controller));

// Stripe: SEM body parser — o controller lê o body como Buffer/string
router.post("/stripe", controller.stripe.bind(controller));

export default router;