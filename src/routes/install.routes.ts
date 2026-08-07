// src/routes/install.routes.ts
// Rotas para instalação e gerenciamento de lojas

import { Router } from "express";
import { InstallController } from "../controllers/InstallController";

const router = Router();
const controller = new InstallController();

// POST /api/shop/install - Recebe dados da loja do App Shopify
router.post("/install", controller.install.bind(controller));

// GET /api/shop/:domain - Busca dados de uma loja
router.get("/:domain", controller.getByDomain.bind(controller));

// GET /api/shop/test/:domain - Testa conexão com Shopify
router.get("/test/:domain", controller.test.bind(controller));

export default router;