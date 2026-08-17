import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { StripeEventProcessor } from "../../src/stripe/StripeEventProcessor";

export const config = { api: { bodyParser: false } };

interface StripeWebhookDependencies {
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event;
  process(event: Stripe.Event): Promise<Record<string, unknown>>;
  rawBodyTimeoutMs: number;
}

export async function readRawBody(req: VercelRequest, timeoutMs: number): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Raw body timeout")), timeoutMs);
  });
  const consume = async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  try { return await Promise.race([consume(), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export function createStripeWebhookHandler(dependencies: StripeWebhookDependencies) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature) return res.status(400).json({ error: "Invalid Stripe signature" });
    let event: Stripe.Event;
    try {
      const rawBody = await readRawBody(req, dependencies.rawBodyTimeoutMs);
      event = dependencies.constructEvent(rawBody, signature);
    } catch {
      return res.status(400).json({ error: "Invalid Stripe signature" });
    }
    try { return res.status(200).json({ received: true, ...(await dependencies.process(event)) }); }
    catch (error) {
      console.error("[Stripe webhook adapter] Processing failed", { error: error instanceof Error ? error.name : "UnknownError" });
      return res.status(500).json({ error: "Stripe webhook processing failed" });
    }
  };
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2025-02-24.acacia" });
const handler = createStripeWebhookHandler({
  constructEvent: (rawBody, signature) => stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET || ""),
  process: (event) => new StripeEventProcessor().process(event),
  rawBodyTimeoutMs: 5_000,
});

export default handler;
