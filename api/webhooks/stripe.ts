// api/webhooks/stripe.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
    console.log("[TESTE] Webhook Stripe chamado!");
    console.log("[TESTE] Method:", req.method);
    console.log("[TESTE] Headers:", JSON.stringify(req.headers, null, 2));
    console.log("[TESTE] Body type:", typeof req.body);
    console.log("[TESTE] Body:", JSON.stringify(req.body).substring(0, 500));

    return res.status(200).json({
        received: true,
        test: "ok",
        timestamp: new Date().toISOString()
    });
}