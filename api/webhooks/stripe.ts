import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { StripeEventProcessor } from "../../src/stripe/StripeEventProcessor";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2025-02-24.acacia" });

function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !signature) return res.status(400).json({ error: "Invalid Stripe signature" });
  let event: Stripe.Event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch {
    return res.status(400).json({ error: "Invalid Stripe signature" });
  }
  try {
    const result = await new StripeEventProcessor().process(event);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    console.error("[Stripe webhook adapter] Processing failed", { error: error instanceof Error ? error.name : "UnknownError" });
    return res.status(500).json({ error: "Stripe webhook processing failed" });
  }
}
