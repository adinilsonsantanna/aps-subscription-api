import { Request, Response } from "express";
import { StripeWebhookService } from "../gateways/stripe/stripe-webhook.service";
import { StripeEventProcessor } from "../stripe/StripeEventProcessor";

export class StripeWebhookController {
  constructor(private verifier = new StripeWebhookService(), private processor = new StripeEventProcessor()) {}
  async handle(req: Request, res: Response) {
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Invalid Stripe signature" });
    let event;
    try { event = this.verifier.constructEvent(req.body, signature); }
    catch { return res.status(400).json({ error: "Invalid Stripe signature" }); }
    try { return res.status(200).json({ received: true, ...(await this.processor.process(event)) }); }
    catch (error) { console.error("[Stripe webhook] Processing failed", { error: error instanceof Error ? error.name : "UnknownError" }); return res.status(500).json({ error: "Stripe webhook processing failed" }); }
  }
}
