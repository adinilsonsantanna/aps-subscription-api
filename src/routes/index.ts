import { Router } from "express";

import shopifyRoutes from "./shopify.routes";
import subscriptionsRoutes from "./subscriptions.routes";
import billingRoutes from "./billing.routes";
import adminRoutes from "./admin.routes";
import webhooksRoutes from "./webhooks.routes";

const router = Router();

router.use("/shopify", shopifyRoutes);
router.use("/subscriptions", subscriptionsRoutes);
router.use("/billing", billingRoutes);
router.use("/admin", adminRoutes);
router.use("/webhooks", webhooksRoutes);

export default router;