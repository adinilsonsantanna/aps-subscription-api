import type { VercelRequest, VercelResponse } from "@vercel/node";
import fs from "fs";
import path from "path";

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const htmlPath = path.join(process.cwd(), "api", "checkout.html");
        const html = fs.readFileSync(htmlPath, "utf8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(html);
    } catch (err: any) {
        console.error("[Checkout] Erro ao ler HTML:", err.message);
        return res.status(500).json({ error: "Erro ao carregar checkout", details: err.message });
    }
}