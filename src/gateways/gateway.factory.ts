import { GatewayInterface } from "./gateway.interface";
import { StripeGateway } from "./stripe/stripe.gateway";

export class GatewayFactory {
    static create(gatewayName: string): GatewayInterface {
        switch (gatewayName) {
            case "stripe":
                return new StripeGateway();
            default:
                throw new Error(`Gateway não suportado: ${gatewayName}`);
        }
    }
}