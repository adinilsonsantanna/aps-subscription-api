import { Router } from "express";
import { ShopifyEventController } from "../controllers/ShopifyEventController";

const router = Router();
const controller = new ShopifyEventController();

router.post("/events", controller.create.bind(controller));

export default router;
