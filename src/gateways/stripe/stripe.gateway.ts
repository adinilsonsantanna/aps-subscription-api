import { GatewayInterface, CreateSubscriptionInput, SubscriptionResult } from "../gateway.interface";
import { StripeCustomerService } from "./stripe-customer.service";
import { StripeSubscriptionService } from "./stripe-subscription.service";

export class StripeGateway implements GatewayInterface {
  private customerService = new StripeCustomerService();
  private subscriptionService = new StripeSubscriptionService();

  async createCustomer(email: string, name?: string) {
    const customer = await this.customerService.create(email, name);
    return { id: customer.id };
  }

  async attachPaymentMethod(customerId: string, paymentMethodId: string) {
    await this.customerService.attachPaymentMethod(customerId, paymentMethodId);
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    let customerId = input.metadata?.stripeCustomerId;

    if (!customerId) {
      const customer = await this.createCustomer(input.customerEmail, input.customerName);
      customerId = customer.id;
    }

    if (input.paymentMethodId) {
      await this.attachPaymentMethod(customerId, input.paymentMethodId);
    }

    const result = await this.subscriptionService.create({
      customerId,
      priceAmount: input.priceAmount,
      currency: input.currency,
      interval: input.interval,
      intervalType: input.intervalType,
      paymentMethodId: input.paymentMethodId,
      metadata: input.metadata,
    });

    return {
      externalId: result.externalId,
      customerId: result.customerId,
      paymentMethodId: result.paymentMethodId,
      status: result.status,
      currentPeriodStart: result.currentPeriodStart,
      currentPeriodEnd: result.currentPeriodEnd,
    };
  }

  async cancelSubscription(externalId: string) {
    await this.subscriptionService.cancel(externalId);
  }

  async getSubscription(externalId: string) {
    return this.subscriptionService.retrieve(externalId);
  }
}