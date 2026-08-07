// src/middlewares/apiAuth.ts
// Middleware que verifica se a requisição vem do App Shopify autorizado
// via header X-API-Key

import { Request, Response, NextFunction } from "express";

export function apiAuth(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers["x-api-key"] as string;

    if (!apiKey) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Header X-API-Key é obrigatório",
        });
    }

    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({
            error: "Forbidden",
            message: "API Key inválida",
        });
    }

    next();
}