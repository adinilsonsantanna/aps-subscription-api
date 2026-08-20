import { Router } from "express";
import { RetryCronController } from "../controllers/RetryCronController";
const router = Router(); const controller = new RetryCronController();
router.post("/retry-billing", controller.run.bind(controller));
router.get("/retry-billing", controller.run.bind(controller));
export default router;
