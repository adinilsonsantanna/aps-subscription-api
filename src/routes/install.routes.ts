import { Router } from "express";
import { InstallController } from "../controllers/InstallController";

const router = Router();
const controller = new InstallController();

router.post("/install", controller.install.bind(controller));

export default router;