export interface CreateSubscriptionInput {
    customerEmail: string;
    customerName?: string;
    priceAmount: number;
    currency: string;
    interval: number;
    intervalType: "day" | "week" | "month" | "year";
    paymentMethodId?: string;
    metadata?: Record<string, string>;
}

export interface SubscriptionResult {
    externalId: string;
    customerId: string;
    paymentMethodId?: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
}

export interface GatewayInterface {
    createCustomer(email: string, name?: string): Promise<{ id: string }>;
    attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
    createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult>;
    cancelSubscription(externalId: string): Promise<void>;
    getSubscription(externalId: string): Promise<any>;
}