// src/middlewares/apiAuth.ts
// Middleware que verifica se a requisição vem do App Shopify autorizado
// via header X-API-Key

import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";

export function secureApiKeyMatches(provided: string | undefined, expected: string | undefined) {
    if (!provided || !expected) {
        return false;
    }

    const providedDigest = createHash("sha256").update(provided).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedDigest, expectedDigest);
}

export function apiAuth(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers["x-api-key"] as string;

    if (!apiKey) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Header X-API-Key é obrigatório",
        });
    }

    if (!secureApiKeyMatches(apiKey, process.env.API_KEY)) {
        return res.status(403).json({
            error: "Forbidden",
            message: "API Key inválida",
        });
    }

    next();
}
