// src/routes/subscriptions.routes.ts
// Rotas para gerenciamento de assinaturas

import { Router } from "express";
import { SubscriptionController } from "../controllers/SubscriptionController";

const router = Router();
const controller = new SubscriptionController();

// GET /api/subscriptions - Lista todas as assinaturas (admin)
router.get("/", controller.listByShop.bind(controller));

// GET /api/subscriptions/shop/:domain - Lista assinaturas de uma loja
router.get("/shop/:domain", controller.listByShop.bind(controller));

// POST /api/subscriptions - Cria uma nova assinatura
router.post("/", controller.create.bind(controller));

// GET /api/subscriptions/:id - Busca uma assinatura pelo ID
router.get("/:id", controller.getById.bind(controller));

// PATCH /api/subscriptions/:id/status - Atualiza status da assinatura
router.patch("/:id/status", controller.updateStatus.bind(controller));

export default router;