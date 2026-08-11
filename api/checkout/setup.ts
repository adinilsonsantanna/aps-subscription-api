import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

    if (!publishableKey) {
        console.error("[Checkout Setup] STRIPE_PUBLISHABLE_KEY nao configurada");
        return res.status(500).json({ error: "STRIPE_PUBLISHABLE_KEY nao configurada" });
    }

    return res.status(200).json({ publishableKey });
}